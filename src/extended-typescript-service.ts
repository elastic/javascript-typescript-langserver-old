import { walkMostAST } from 'javascript-typescript-langserver/lib/ast'
import { LanguageClient } from 'javascript-typescript-langserver/lib/lang-handler'
import { extractNodeModulesPackageName } from 'javascript-typescript-langserver/lib/packages'
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
import { Hover, Location, MarkedString, MarkupContent, SymbolInformation, TextDocumentPositionParams } from 'vscode-languageserver'

import {
    DetailSymbolInformation,
    Full,
    FullParams,
    PackageLocator,
    Reference,
    ReferenceCategory,
    SymbolLocator
} from '@codesearch/lsp-extension'

import { DependencyManager } from './dependency-manager'

import * as rxjs from 'rxjs'

export class ExtendedTypescriptService extends TypeScriptService {
    private dependencyManager: DependencyManager | null // TODO should we assign null

    private subscriptions = new rxjs.Subscription()

    constructor(protected client: LanguageClient, protected options: TypeScriptServiceOptions = {}) {
        super(client, options)
        // @ts-ignore
        // @ts-ignore
        // this.traceModuleResolution = true;
    }

    public initialize(params: InitializeParams, span?: Span): Observable<Operation> {
        // TODO what about the promise here?
        // TODO run dependencyManager
        return super.initialize(params).finally(() => {
            // Must run after super.initialize
            this.dependencyManager = new DependencyManager(
                this.projectManager,
                this.packageManager,
                this.inMemoryFileSystem
            )

            // Similar to promise then
            this.subscriptions.add(
                Observable.defer(() => {
                    if (this.dependencyManager) {
                        // this.fileSystem.getWorkspaceFiles().forEach(f => {
                        //     if (f.endsWith("package.json")) { // this ensure the file is updated to package manager
                        //         this.fileSystem.getTextDocumentContent(f).forEach(c => {
                        //             console.log(this.packageManager.packageJsonUris()); // just test code
                        //         })
                        //     }
                        // })

                        // fileContentPair.forEach(p => {
                        //     this.inMemoryFileSystem.add(p[0], p(1))
                        // })

                        return this.dependencyManager.installDependency()
                    } else {
                        this.logger.error('dependencyManager null')
                        // TODO is this the right way?
                        return Promise.resolve()
                    }
                }).subscribe(undefined, e => {
                    this.logger.info('xxx', e)
                })
            )
        })
    }

    public shutdown(params?: {}, span?: Span): Observable<Operation> {
        this.subscriptions.unsubscribe()

        // TODO shutdown depenency manager
        if (this.dependencyManager) {
            this.dependencyManager.shutdown()
            this.dependencyManager = null
        } else {
            this.logger.error('dependencyManager null')
        }
        return super.shutdown(params)
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

    public textDocumentFull(params: FullParams, span = new Span()): Observable<Operation> {
        const uri = normalizeUri(params.textDocument.uri)

        // Ensure files needed to resolve symbols are fetched
        const files = this.projectManager.ensureReferencedFiles(uri, undefined, undefined, span).toArray()

        const symbols: Observable<DetailSymbolInformation[]> = this._getPackageDescriptor(uri).zip(files)
            .mergeMap(res => {
                const fileName = uri2path(uri)
                const packageDescriptor = res[0]

                const config = this.projectManager.getConfiguration(fileName)
                config.ensureBasicFiles(span)
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
                            const info = config
                                .getService()
                                .getQuickInfoAtPosition(uri2path(symbolInformation.location.uri), tree.spans[0].start + 1)

                            let contents: MarkupContent | MarkedString | MarkedString[] = ''
                            if (info) {
                                contents = this.getHoverForSymbol(info)
                            }
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
            references = files
                .mergeMap(() => {
                    const fileName = uri2path(uri)

                    // TODO maybe it's better to have a flag
                    if (fileName.endsWith('.min.js')) {
                        return []
                    }

                    const config = this.projectManager.getConfiguration(fileName)
                    config.ensureBasicFiles(span)
                    const sourceFile = this._getSourceFile(config, fileName, span)
                    if (!sourceFile) {
                        return []
                    }

                    return (
                        observableFromIterable(walkMostAST(sourceFile))
                        // Filter Identifier Nodes
                        // Filter defintion self reference
                        // TODO: include string-interpolated references
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
                                        `textdocument/xreferences: Error getting definition for ${
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

        return this._getPackageDescriptor(uri).map(descriptor => {
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
            .map(symbol => ({ op: 'add', path: '/-', value: this.getSymbolLocatorFromLocationInformation(symbol) } as Operation))
            .startWith({ op: 'add', path: '', value: [] })
    }

    private getSymbolLocatorFromLocationInformation(locationInfo: SymbolLocationInformation): SymbolLocator {
        return {
            qname: this.getQname(locationInfo.symbol), // TODO construct right qname
            symbolKind: stringtoSymbolKind(locationInfo.symbol.kind),
            path: locationInfo.symbol.filePath,
            package: this.getPackageLocator(locationInfo.symbol.package),
            location: locationInfo.location  // TODO check if location need to be adjusted
        }
    }

    private getQname(desc: SymbolDescriptor): string {
        let prefix = ''
        if (desc.package) {
            prefix += desc.package.name + '.'
        } else {
            prefix = 'unknown.'
        }

        if (desc.name === "Error") {
            console.log("")
        }

        //  TODO check with type
        if (desc.filePath !== '') {
            prefix += this.getFileName(desc.filePath) + '.'
        }
        if (desc.containerName !== '') {
            prefix += desc.containerName + '.'
        }
        return prefix + desc.name
    }

    private getQnameBySymbolInformation(info: SymbolInformation, packageLocator: PackageLocator | undefined): string {
        let prefix = ''
        if (packageLocator && packageLocator.name && packageLocator.name !== '') {
            prefix += packageLocator.name + '.'
        } else {
            prefix = 'unknown'
        }
        if (info.location.uri !== '') {
            prefix += this.getFileName(info.location.uri) + '.'
        }
        if (info.containerName && info.containerName !== '') {
            prefix += info.containerName + '.'
        }
        return prefix + info.name
    }

    private getFileName(pathOrUri: string): string {
        // @ts-ignore
        const fileName: string = pathOrUri.split('\\').pop().split('/').pop()
        return fileName.substr(0, fileName.indexOf('.'))
    }
}
