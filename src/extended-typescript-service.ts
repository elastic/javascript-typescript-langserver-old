import { walkMostAST } from 'javascript-typescript-langserver/lib/ast'
import { LanguageClient } from 'javascript-typescript-langserver/lib/lang-handler'
import { extractNodeModulesPackageName } from 'javascript-typescript-langserver/lib/packages'
import { InitializeParams, SymbolDescriptor } from 'javascript-typescript-langserver/lib/request-type'
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
import { Hover, Location,  MarkedString, MarkupContent, TextDocumentPositionParams } from 'vscode-languageserver'

import { DetailSymbolInformation, Full, FullParams, Reference, ReferenceCategory } from '@codesearch/lsp-extension'
import { DependencyManager } from './dependency-manager'

import * as rxjs from 'rxjs'

export class ExtendedTypescriptService extends TypeScriptService {
    private dependencyManager: DependencyManager | null; // TODO should we assign null

    private subscriptions = new rxjs.Subscription()

    constructor(protected client: LanguageClient, protected options: TypeScriptServiceOptions = {}) {
        super(client, options);
        // @ts-ignore
        // @ts-ignore
        // this.traceModuleResolution = true;
    }

    public initialize(params: InitializeParams, span?: Span): Observable<Operation> {
        // TODO what about the promise here?
        // TODO run dependencyManager
        return super.initialize(params).finally(() => {
            // Must run after super.initialize
            this.dependencyManager = new DependencyManager(this.projectManager, this.packageManager, this.inMemoryFileSystem);

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
                        return Promise.resolve();
                    }
                }).subscribe(undefined, e => {
                        this.logger.info('xxx', e);
                    }
                )
            )
        })
    }

     public shutdown(params?: {}, span?: Span): Observable<Operation> {
        this.subscriptions.unsubscribe();

        // TODO shutdown depenency manager
        if (this.dependencyManager) {
            this.dependencyManager.shutdown()
            this.dependencyManager = null
        } else {
            this.logger.error('dependencyManager null')
        }
        return super.shutdown(params);
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
        return contents;
    }

    public textDocumentFull(params: FullParams, span = new Span()): Observable<Operation> {
        const uri = normalizeUri(params.textDocument.uri)

        // Ensure files needed to resolve symbols are fetched
        const files = this.projectManager.ensureReferencedFiles(uri, undefined, undefined, span).toArray()

        const symbols: Observable<DetailSymbolInformation[]> = files
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
                    .filter(({ tree, parent }) => navigationTreeIsSymbol(tree))
                    .map(({ tree, parent }) => {
                        const symbolInformation = navigationTreeToSymbolInformation(tree, parent, sourceFile, this.root);
                        const info = config.getService().getQuickInfoAtPosition(uri2path(
                            symbolInformation.location.uri), tree.spans[0].start + 1)

                        return {
                            symbolInformation,
                            contents:  this.getHoverForSymbol(info),
                        }
                    })
            })
            .toArray()

        const references: Observable<Reference[]> = files
            .mergeMap(() => {
                const fileName = uri2path(uri)

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

                                        const symbolLoc: Location = {
                                            uri,
                                            range: {
                                                start: ts.getLineAndCharacterOfPosition(defintionSourceFile!, definition.textSpan.start),
                                                end:  ts.getLineAndCharacterOfPosition(defintionSourceFile!, ts.textSpanEnd(definition.textSpan)),
                                            },
                                        }
                                        return packageDescriptor.map(symbolDescriptor => [symbolDescriptor, symbolLoc])
                                    })
                                    .map((pair: [SymbolDescriptor, Location]): Reference => {
                                        const symbolDescriptor = pair[0]
                                        return {
                                            category: ReferenceCategory.UNCATEGORIZED, // TODO add category
                                            symbol: {
                                                name: symbolDescriptor.name,
                                                kind: stringtoSymbolKind(symbolDescriptor.kind),
                                                location: pair[1],
                                            },
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
            return h;
        })
    }

    // Fix go to definition
    protected _getDefinitionLocations(
        params: TextDocumentPositionParams,
        span = new Span(),
        goToType = false
    ): Observable<Location> {
        const original = super._getDefinitionLocations(params, span, goToType);
        return original.map(location => this.convertLocation(location))
    }

    private convertLocation(location: Location): Location {
        location.uri = this.convertUri(location.uri);
        return location;
    }

    private convertUri(uri: string): string {
        const packageName = extractNodeModulesPackageName(uri);
        if (!packageName) {
            return uri;
        }
        // console.log(packageName);
        const decodedUri = decodeURIComponent(uri);
        let result = 'git://github.com/';
        // TODO use the right revision
        if (packageName.startsWith('@types/')) {
            result += `DefinitelyTyped/DefinitelyTyped/blob/head/${decodedUri.substr(decodedUri.indexOf(packageName) + 1)}`
        }
        // TODO handle other packages

        return result;
    }

    private replaceWorkspaceInDoc(doc: MarkupContent | MarkedString | MarkedString[]): MarkupContent | MarkedString | MarkedString[] {
        if (doc instanceof Array) {
            for (let i = 0; i < doc.length; i++) {
                // @ts-ignore
                doc[i] = this.replaceWorkspaceInDoc(doc[i])
            }
        } else if (typeof doc === 'string')  {
            return this.replaceWorkspaceInString(doc)
        } else {
            doc.value = this.replaceWorkspaceInString(doc.value)
        }
        return doc
    }

    private replaceWorkspaceInString(str: string): string {
        let res = str.replace(this.projectManager.getRemoteRoot(), '');
        res = res.replace('\"node_modules/', '\"')
        return res;
    }
}
