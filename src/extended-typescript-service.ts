import { walkMostAST } from 'javascript-typescript-langserver/lib/ast'
import { LocalFileSystem, RemoteFileSystem } from 'javascript-typescript-langserver/lib/fs';
import { LanguageClient } from 'javascript-typescript-langserver/lib/lang-handler'
import { extractNodeModulesPackageName } from 'javascript-typescript-langserver/lib/packages'
import { ProjectConfiguration } from 'javascript-typescript-langserver/lib/project-manager'
import {
    InitializeParams,
    PackageDescriptor,
    SymbolDescriptor,
    SymbolLocationInformation
} from 'javascript-typescript-langserver/lib/request-type'
import {
    definitionInfoToSymbolDescriptor,
    locationUri,
    navigationTreeIsSymbol,
    navigationTreeToSymbolInformation,
    stringtoSymbolKind,
    walkNavigationTree,
} from 'javascript-typescript-langserver/lib/symbols'
import { TypeScriptService, TypeScriptServiceOptions } from 'javascript-typescript-langserver/lib/typescript-service'
import { normalizeUri, observableFromIterable, path2uri, uri2path } from 'javascript-typescript-langserver/lib/util'

import { Operation } from 'fast-json-patch'
import { Span } from 'opentracing'
import { Observable } from 'rxjs'
import * as ts from 'typescript'
import {
    DocumentSymbolParams,
    Hover,
    Location,
    MarkedString,
    MarkupContent,
    ReferenceParams,
    SymbolInformation,
    TextDocumentPositionParams
} from 'vscode-languageserver'

import {
    DetailSymbolInformation,
    Full,
    FullParams,
    PackageLocator,
    Reference,
    ReferenceCategory,
    SymbolLocator
} from '@elastic/lsp-extension'

import { DependencyManager } from './dependency-manager'
import { PatchedInMemoryFileSystem } from './memfs';

export class ExtendedTypescriptService extends TypeScriptService {
    private dependencyManager: DependencyManager | null // TODO should we assign null

    constructor(protected client: LanguageClient, protected options: TypeScriptServiceOptions = {}) {
        super(client, options)
        // @ts-ignore
        // @ts-ignore
        // this.traceModuleResolution = true;
    }

    protected _initializeFileSystems(accessDisk: boolean): void {
        this.fileSystem = accessDisk ? new LocalFileSystem(this.rootUri) : new RemoteFileSystem(this.client)
        this.inMemoryFileSystem = new PatchedInMemoryFileSystem(this.root, this.logger)
    }

    public initialize(params: InitializeParams, span?: Span): Observable<Operation> {
        // TODO what about the promise here?
        this.dependencyManager = new DependencyManager(
            params.rootPath || uri2path(params.rootUri!)
        )

        if (params.initializationOptions.installNodeDependency) {
            this.dependencyManager.installDependency()
        }

        return super.initialize(params).flatMap(r => {
                const trimmedRootPath = this.projectManager.getRemoteRoot().replace(/[\\\/]+$/, '')
                const fallbackConfigJs = this.projectManager.getConfiguration(trimmedRootPath, 'js')
                const fallbackConfigTs = this.projectManager.getConfiguration(trimmedRootPath, 'ts')

                // Must run after super.initialize
                this.projectManager.ensureConfigDependencies()
                return this.projectManager.ensureModuleStructure().defaultIfEmpty(undefined).map(() => {
                    // We want to make sure root config at least exist, todo, submit a patch
                    if (!this.projectManager.getConfigurationIfExists(trimmedRootPath, 'js')) {
                        // @ts-ignore
                        this.projectManager.configs.js.set(trimmedRootPath, fallbackConfigJs)
                    }
                    if (!this.projectManager.getConfigurationIfExists(trimmedRootPath, 'ts')) {
                        // @ts-ignore
                        this.projectManager.configs.ts.set(trimmedRootPath, fallbackConfigTs)
                    }
                    return r;
                })
            }
        )
    }

    public shutdown(params?: {}, span?: Span): Observable<Operation> {
        // TODO shutdown depenency manager
        if (this.dependencyManager) {
            this.dependencyManager.shutdown()
            this.dependencyManager = null
        } else {
            this.logger.error('dependencyManager null')
        }

        if (this.projectManager !== null) {
            return super.shutdown(params)
        } else {
            this.logger.error('Server not properly initialized before shutdown');
            return Observable.of({ op: 'add', path: '', value: null } as Operation);
        }
    }

    // @ts-ignore
    private getHoverForSymbol(info: ts.QuickInfo): MarkupContent | MarkedString | MarkedString[] {
        if (!info) {
            return []
        }
        // @ts-ignore
        const contents: (MarkedString | string)[] = []
        // Add declaration without the kind
        const declaration = ts.displayPartsToString(info.displayParts).replace(/^\(.+?\)\s+/, '')
        contents.push({ language: 'typescript', value: this.replaceWorkspaceInString(declaration) })

        if (info.kind) {
            let kind = '**' + info.kind + '**'
            const modifiers = info.kindModifiers
                .split(',')
                // Filter out some quirks like "constructor (exported)"
                .filter(
                    mod =>
                        mod &&
                        (mod !== ts.ScriptElementKindModifier.exportedModifier ||
                            info.kind !== ts.ScriptElementKind.constructorImplementationElement)
                )
                // Make proper adjectives
                .map(mod => {
                    switch (mod) {
                        case ts.ScriptElementKindModifier.ambientModifier:
                            return 'ambient'
                        case ts.ScriptElementKindModifier.exportedModifier:
                            return 'exported'
                        default:
                            return mod
                    }
                })
            if (modifiers.length > 0) {
                kind += ' _(' + modifiers.join(', ') + ')_'
            }
            contents.push(kind)
        }
        // Add documentation
        const documentation = ts.displayPartsToString(info.documentation)
        if (documentation) {
            contents.push(documentation)
        }
        return contents
    }

    private emptyOperation = Observable.of({ op: 'add', path: '', value: [{ symbols: [], references: [] }] } as Operation);

    public textDocumentFull(params: FullParams, span = new Span()): Observable<Operation> {
        const uri = normalizeUri(params.textDocument.uri)
        const fileName = uri2path(uri)

        // TODO, the idea logic might be, don't index reference file large than xxx lines
        // don't index at all if file larger than xxx lines
        if (fileName.indexOf('bundle.js') !== -1) {
            return this.emptyOperation
        }

        let config: ProjectConfiguration;

        try {
            config = this.projectManager.getConfiguration(fileName)
        } catch (error) {
            this.logger.error('No tsconfig found for source files')
            return this.emptyOperation;
        }

        // Ensure files needed to resolve symbols are fetched
        // const files = this.projectManager.ensureReferencedFiles(uri, undefined, undefined, span).toArray()
        config.ensureBasicFiles();

        const symbols: Observable<DetailSymbolInformation[]> = this._getPackageDescriptor(uri)
            .defaultIfEmpty(undefined)
            .mergeMap(packageDescriptor => {

                // TODO maybe move out to common block?
                const sourceFile = this._getSourceFile(config, fileName, span)
                if (!sourceFile) {
                    return []
                }

                const tree = config.getService().getNavigationTree(fileName)
                return observableFromIterable(walkNavigationTree(tree))
                        .filter(({tree, parent}) => navigationTreeIsSymbol(tree))
                        .map(value => {
                            const {tree, parent} = value
                            const symbolInformation = navigationTreeToSymbolInformation(tree, parent, sourceFile, this.root)
                            // TODO if there is no performance issue we should reenable content index
                            // const info = config
                            //     .getService()
                            //     .getQuickInfoAtPosition(uri2path(symbolInformation.location.uri), tree.spans[0].start + 1)
                            //
                            const contents: MarkupContent | MarkedString | MarkedString[] = ''
                            // if (info) {
                            //     contents = this.getHoverForSymbol(info)
                            // }
                            const packageLocator = this.getPackageLocator(packageDescriptor)
                            const qname =  this.getQnameBySymbolInformation(symbolInformation, packageLocator)
                            return {
                                qname,
                                symbolInformation,
                                contents,
                                package: packageLocator
                            }
                        })
                })
            .toArray()

        let references: Observable<Reference[]> = Observable.of([]);
        if (params.reference) {
            references = Observable.of() // TODO remove this
                .mergeMap(() => {

                    // TODO maybe it's better to have a flag
                    if (fileName.endsWith('.min.js')) {
                        return []
                    }

                    const sourceFile = this._getSourceFile(config, fileName, span)
                    if (!sourceFile) {
                        return []
                    }

                    return (
                        observableFromIterable(walkMostAST(sourceFile))
                        // Filter Identifier Nodes
                        // Filter defintion self reference
                        // TODO: include string-interpolated references
                        // @ts-ignore
                            .filter((node): node is ts.Identifier => node.kind === ts.SyntaxKind.Identifier)
                            .mergeMap(node => {
                                try {
                                    // Find definition for node
                                    return Observable.from(
                                        config.getService().getDefinitionAtPosition(sourceFile.fileName, node.pos + 1) || []
                                    )
                                        .mergeMap(definition => {
                                            const symbol = definitionInfoToSymbolDescriptor(definition, this.root)
                                            const uri = path2uri(definition.fileName)

                                            const packageDescriptor = this._getPackageDescriptor(uri, span)
                                                .defaultIfEmpty(undefined)
                                                .map(packageDescriptor => {
                                                    symbol.package = packageDescriptor
                                                    return symbol
                                                })

                                            const defintionSourceFile = this._getSourceFile(config, fileName, span)
                                            if (!defintionSourceFile) {
                                                this.logger.error('Definition Source File not found')
                                            }

                                            const symbolLoc = this.convertLocation({
                                                uri,
                                                range: {
                                                    start: ts.getLineAndCharacterOfPosition(
                                                        defintionSourceFile!,
                                                        definition.textSpan.start
                                                    ),
                                                    end: ts.getLineAndCharacterOfPosition(
                                                        defintionSourceFile!,
                                                        ts.textSpanEnd(definition.textSpan)
                                                    ),
                                                },
                                            })
                                            return packageDescriptor.zip(symbolLoc)
                                        })
                                        .map((pair: [SymbolDescriptor, Location]): Reference => {
                                            const symbolDescriptor = pair[0]
                                            return {
                                                category: ReferenceCategory.UNCATEGORIZED, // TODO add category
                                                target: this.getSymbolLocator(symbolDescriptor, pair[1]),
                                                location: {
                                                    uri: locationUri(sourceFile.fileName),
                                                    range: {
                                                        start: ts.getLineAndCharacterOfPosition(sourceFile, node.pos),
                                                        end: ts.getLineAndCharacterOfPosition(sourceFile, node.end),
                                                    },
                                                },
                                            }
                                        })
                                } catch (err) {
                                    // Continue with next node on error
                                    // Workaround for https://github.com/Microsoft/TypeScript/issues/15219
                                    this.logger.error(
                                        `textdocument/full: Error getting definition for ${
                                            sourceFile.fileName
                                            } at offset ${node.pos + 1}`,
                                        err
                                    )
                                    span.log({
                                        event: 'error',
                                        'error.object': err,
                                        message: err.message,
                                        stack: err.stack,
                                    })
                                    return []
                                }
                            })
                    )
                })
                .toArray()
        }

        return symbols
            .zip(references)
            .map(res => {
                const full: Full = { symbols: res[0], references: res[1] }
                return { op: 'add', path: '/-', value: full } as Operation
            })
            .startWith({ op: 'add', path: '', value: [] } as Operation)
    }

    protected _getHover(params: TextDocumentPositionParams, span = new Span()): Observable<Hover> {
        const res = super._getHover(params, span)
        return res.map(h => {
            h.contents = this.replaceWorkspaceInDoc(h.contents)
            return h
        })
    }

    // Fix go to definition
    protected _getDefinitionLocations(
        params: TextDocumentPositionParams,
        span = new Span(),
        goToType = false
    ): Observable<Location> {
        const original = super._getDefinitionLocations(params, span, goToType)
        return original.flatMap(location => this.convertLocation(location))
    }

    private convertLocation(location: Location): Observable<Location> {
        return this.convertUri(location.uri).map(value => {
            location.uri = value
            return location
        })
    }
    private convertUri(uri: string): Observable<string> {
        const decodedUri = decodeURIComponent(uri)

        const packageName = extractNodeModulesPackageName(uri)
        if (!packageName) {
            return Observable.of(uri)
        }

        return this._getPackageDescriptor(uri).defaultIfEmpty(undefined).map(descriptor => {
            const { name, version, repoURL } = descriptor
            if (!repoURL) {
                return uri
            }
            let finalURL = 'git://' + repoURL.substring(repoURL.indexOf('://') + 3)
            if (finalURL.endsWith('.git')) {
                finalURL = finalURL.substr(0, finalURL.length - 4)
            }
            let finalVersion = !version ? version : 'master' // TODO have better syntax

            // TODO use path seperator?
            const moduleString = `node_modules/${name}`
            let path = decodedUri.substr(decodedUri.indexOf(moduleString) + moduleString.length + 1)

            if (name === 'typescript')   {
                finalVersion = 'v' + ts.version
            } else if (uri.startsWith('git://github.com/Microsoft/TypeScript?v')) {
                //  handle the case the the path is already srcgraph's typescript address (see locationUri)
                return uri.replace('#', '/').replace('?', 'blob/')
            } else if (name.startsWith('@types/')) {
                // TODO fix version
                finalVersion = 'master'
                path = name.substr(1) + '/' + path
            } else if (finalURL.endsWith('vscode-languageserver-node')) {
                // Following should be our standard package mapping
                const nameMap: { [key : string] : [string, string?] }  = {
                    'vscode-languageclient': ['client'],
                    'vscode-languageserver': ['server'],
                    'vscode-languageserver-protocol': ['protocol'],
                    'vscode-languageserver-types': ['types'],
                    'vscode-jsonrpc': ['json-rpc', 'jsonrpc']
                }
                // TODO we might not need this in the future
                finalVersion = encodeURIComponent(`release/${nameMap[name][0]}/${version}`)
                let basePath = nameMap[name][1]
                if (!basePath) {
                    basePath = nameMap[name][0]
                }
                // TODO this is not right because there is no 'lib' dir (it's generated)
                // We'll want symbol:// schema for those whose file are not existed
                path = basePath + '/' + path
            }

            return `${finalURL}/blob/${finalVersion}/${path}`
        })
    }

    private replaceWorkspaceInDoc(
        doc: MarkupContent | MarkedString | MarkedString[]
    ): MarkupContent | MarkedString | MarkedString[] {
        if (doc instanceof Array) {
            for (let i = 0; i < doc.length; i++) {
                // @ts-ignore
                doc[i] = this.replaceWorkspaceInDoc(doc[i])
            }
        } else if (typeof doc === 'string') {
            return this.replaceWorkspaceInString(doc)
        } else {
            doc.value = this.replaceWorkspaceInString(doc.value)
        }
        return doc
    }

    private replaceWorkspaceInString(str: string): string {
        let res = str.replace(this.projectManager.getRemoteRoot(), '')
        res = res.replace('"node_modules/', '"') // TODO consider windows path?
        return res
    }

    private getPackageLocator(packageDescriptor?: PackageDescriptor): PackageLocator | undefined {
        if (!packageDescriptor) {
            return undefined
        }
        return {
            name: packageDescriptor.name,
            repoUri: packageDescriptor.repoURL,
            version: packageDescriptor.version
        }
    }

    private getSymbolLocator(descriptor: SymbolDescriptor, location: Location): SymbolLocator {
        return {
            qname: this.getQname(descriptor), // TODO construct right qname
            symbolKind: stringtoSymbolKind(descriptor.kind),
            path: descriptor.filePath,
            package: this.getPackageLocator(descriptor.package),
            location, // TODO location part might need to be adjusted
        }
    }

    public textDocumentEdefinition(params: TextDocumentPositionParams, span = new Span()): Observable<Operation> {
        return this._getSymbolLocationInformations(params, span)
            .flatMap(symbol => this.getSymbolLocatorFromLocationInformation(symbol))
            .map(symbol => ({ op: 'add', path: '/-', value: symbol } as Operation))
            .startWith({ op: 'add', path: '', value: [] })
    }

    private getSymbolLocatorFromLocationInformation(locationInfo: SymbolLocationInformation): Observable<SymbolLocator> {
        // let location: Observable<Location> | undefined
        if (locationInfo.location) {
            return this.convertLocation(locationInfo.location).map(l => ({
                qname: this.getQname(locationInfo.symbol), // TODO construct right qname
                symbolKind: stringtoSymbolKind(locationInfo.symbol.kind),
                path: locationInfo.symbol.filePath,
                package: this.getPackageLocator(locationInfo.symbol.package),
                location: l
            }))
        }
        return Observable.of({
            qname: this.getQname(locationInfo.symbol), // TODO construct right qname
            symbolKind: stringtoSymbolKind(locationInfo.symbol.kind),
            path: locationInfo.symbol.filePath,
            package: this.getPackageLocator(locationInfo.symbol.package),
            location: undefined
        })
    }

    private getQname(desc: SymbolDescriptor): string {
        let prefix = ''
        // if (desc.package) {
        //     prefix += desc.package.name + '.'
        // } else {
        //     prefix = 'unknown.'
        // }

        // if (desc.name === "Error") {
        //     console.log("")
        // }

        //  TODO check with type

        const fileName = this.getFileName(desc.filePath)
        // const simpleName = this.getSimpleFileName(fileName)

        // if (desc.filePath !== '') {
        //     prefix += simpleName + '.'
        // }
        if (desc.containerName !== '' && desc.containerName.indexOf(fileName) === -1) {
            prefix += this.cleanContainerName(desc.containerName) + '.'
        }
        return prefix + desc.name
    }

    private getQnameBySymbolInformation(info: SymbolInformation, packageLocator: PackageLocator | undefined): string {
        let prefix = ''
        // if (packageLocator && packageLocator.name && packageLocator.name !== '') {
        //     prefix += packageLocator.name + '.'
        // } else {
        //     prefix = 'unknown'
        // }
        const fileName = this.getFileName(info.location.uri)
        // const simpleName = this.getSimpleFileName(fileName)
        // if (info.location.uri !== '') {
        //     prefix += simpleName + '.'
        // }
        if (info.containerName && info.containerName !== '' && info.containerName.indexOf(fileName) === -1) {
            prefix += this.cleanContainerName(info.containerName) + '.'
        }
        return prefix + info.name
    }

    private getFileName(pathOrUri: string): string {
        // @ts-ignore
        return pathOrUri.split('\\').pop().split('/').pop()
        // return fileName.substr(0, fileName.indexOf('.'))
    }

    private cleanContainerName(name: string): string {
        return name.split('"').join('').split('\\').join('.').split('/').join('.')
    }

    // private getSimpleFileName(file: string): string {
    //     let ext = file.lastIndexOf('.js')
    //     if (ext === -1) {
    //         ext = file.lastIndexOf('.d.ts')
    //     }
    //     if (ext === -1) {
    //         ext = file.lastIndexOf('.ts')
    //     }
    //     if (ext === -1) {
    //         return file
    //     }
    //     return file.substr(0, ext)
    // }

    public textDocumentDocumentSymbol(params: DocumentSymbolParams, span = new Span()): Observable<Operation> {
        const uri = normalizeUri(params.textDocument.uri)

        // Ensure files needed to resolve symbols are fetched
        return this.projectManager
            .ensureReferencedFiles(uri, undefined, undefined, span)
            .toArray()
            .mergeMap(() => {
                const fileName = uri2path(uri)

                const config = this.projectManager.getConfiguration(fileName)
                config.ensureBasicFiles(span)
                const sourceFile = this._getSourceFile(config, fileName, span)
                if (!sourceFile) {
                    return []
                }
                const tree = config.getService().getNavigationTree(fileName)
                return observableFromIterable(walkNavigationTree(tree))
                    .filter(({ tree, parent }) => navigationTreeIsSymbol(tree) && tree.kind !== 'module') // tree.kind !== 'module' is extra
                    .map(({ tree, parent }) => navigationTreeToSymbolInformation(tree, parent, sourceFile, this.root))
            })
            .map(symbol => ({ op: 'add', path: '/-', value: symbol } as Operation))
            .startWith({ op: 'add', path: '', value: [] } as Operation)
    }

    // Just remove the ensureAllFiles
    public textDocumentReferences(params: ReferenceParams, span = new Span()): Observable<Operation> {
        const uri = normalizeUri(params.textDocument.uri)

        // Ensure all files were fetched to collect all references
        return (
            // this.projectManager
                // .ensureOwnFiles(span)
                // .concat(
                    Observable.defer(() => {
                        // Convert URI to file path because TypeScript doesn't work with URIs
                        const fileName = uri2path(uri)
                        // Get tsconfig configuration for requested file
                        const configuration = this.projectManager.getConfiguration(fileName)
                        // Ensure all files have been added
                        // configuration.ensureAllFiles(span)
                        const program = configuration.getProgram(span)
                        if (!program) {
                            return Observable.empty<never>()
                        }
                        // Get SourceFile object for requested file
                        const sourceFile = this._getSourceFile(configuration, fileName, span)
                        if (!sourceFile) {
                            throw new Error(`Source file ${fileName} does not exist`)
                        }
                        // Convert line/character to offset
                        const offset: number = ts.getPositionOfLineAndCharacter(
                            sourceFile,
                            params.position.line,
                            params.position.character
                        )
                        // Request references at position from TypeScript
                        // Despite the signature, getReferencesAtPosition() can return undefined
                        return Observable.from(
                            configuration.getService().getReferencesAtPosition(fileName, offset) || []
                        )
                            .filter(
                                reference =>
                                    // Filter declaration if not requested
                                    (!reference.isDefinition ||
                                        (params.context && params.context.includeDeclaration)) &&
                                    // Filter references in node_modules
                                    !reference.fileName.includes('/node_modules/')
                            )
                            .map(
                                (reference): Location => {
                                    const sourceFile = program.getSourceFile(reference.fileName)
                                    if (!sourceFile) {
                                        throw new Error(`Source file ${reference.fileName} does not exist`)
                                    }
                                    // Convert offset to line/character position
                                    const start = ts.getLineAndCharacterOfPosition(sourceFile, reference.textSpan.start)
                                    const end = ts.getLineAndCharacterOfPosition(
                                        sourceFile,
                                        reference.textSpan.start + reference.textSpan.length
                                    )
                                    return {
                                        uri: path2uri(reference.fileName),
                                        range: {
                                            start,
                                            end,
                                        },
                                    }
                                }
                            )
                    })
                )
                .map((location: Location): Operation => ({ op: 'add', path: '/-', value: location }))
                // Initialize with array
                .startWith({ op: 'add', path: '', value: [] })
        // )
    }
}

export type ExtendedTypescriptServiceFactory = (client: LanguageClient, options?: TypeScriptServiceOptions) => ExtendedTypescriptService
