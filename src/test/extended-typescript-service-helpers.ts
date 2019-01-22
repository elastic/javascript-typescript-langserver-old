import * as chai from 'chai'
import chaiAsPromised = require('chai-as-promised')

import { Full, SymbolLocator } from '@elastic/lsp-extension'
import { applyReducer, Operation } from 'fast-json-patch'
import { LanguageClient } from 'javascript-typescript-langserver/lib/lang-handler'
import {
    initializeTypeScriptService,
    shutdownTypeScriptService,
} from 'javascript-typescript-langserver/lib/test/typescript-service-helpers'
import { Context } from 'mocha'
import * as sinon from 'sinon'

import { ExtendedTypescriptService, ExtendedTypescriptServiceFactory } from '../extended-typescript-service'

chai.use(chaiAsPromised)
const assert = chai.assert

export interface ExtendedTestContext {
    /** TypeScript service under test */
    service: ExtendedTypescriptService
    /** Stubbed LanguageClient */
    client: { [K in keyof LanguageClient]: LanguageClient[K] & sinon.SinonStub }
}
//
// const DEFAULT_CAPABILITIES: ClientCapabilities = {
//     xcontentProvider: true,
//     xfilesProvider: true,
// }
//
// export const initializeTypeScriptService = (
//     createService: ExtendedTypescriptServiceFactory,
//     rootUri: string,
//     files: Map<string, string>,
//     clientCapabilities: ClientCapabilities = DEFAULT_CAPABILITIES
// ) =>
//     async function (this: ExtendedTestContext & Context): Promise<void> {
//         // Stub client
//         this.client = sinon.createStubInstance(RemoteLanguageClient)
//         this.client.textDocumentXcontent.callsFake(
//             (params: TextDocumentContentParams): Observable<TextDocumentItem> => {
//                 if (!files.has(params.textDocument.uri)) {
//                     console.log(params);
//                     return Observable.throw(new Error(`Text document ${params.textDocument.uri} does not exist`))
//                 }
//                 return Observable.of({
//                     uri: params.textDocument.uri,
//                     text: files.get(params.textDocument.uri)!,
//                     version: 1,
//                     languageId: '',
//                 })
//             }
//         )
//         this.client.workspaceXfiles.callsFake(
//             (params: WorkspaceFilesParams): Observable<TextDocumentIdentifier[]> =>
//                 observableFromIterable(files.keys())
//                     .map(uri => ({uri}))
//                     .toArray()
//         )
//         this.client.xcacheGet.callsFake(() => Observable.of(null))
//         this.client.workspaceApplyEdit.callsFake(() => Observable.of({applied: true}))
//         this.service = createService(this.client)
//
//         await this.service
//             .initialize({
//                 processId: process.pid,
//                 rootUri,
//                 capabilities: clientCapabilities || DEFAULT_CAPABILITIES,
//                 workspaceFolders: [
//                     {
//                         uri: rootUri,
//                         name: 'test',
//                     },
//                 ],
//             })
//             .toPromise()
//     }

export function describeTypeScriptService(
    createService: ExtendedTypescriptServiceFactory,
    shutdownService = shutdownTypeScriptService,
    rootUri: string
): void {
    describe('Workspace without project files', () => {
        beforeEach(
            initializeTypeScriptService(
                createService,
                rootUri,
                new Map([
                    [rootUri + 'a.ts', 'const abc = 1; console.log(abc);'],
                    [rootUri + 'foo/b.ts', ['/* This is class Foo */', 'export class Foo {}'].join('\n')],
                    [rootUri + 'foo/c.ts', 'import {Foo} from "./b";'],
                    [rootUri + 'd.ts', ['export interface I {', '  target: string;', '}'].join('\n')],
                    [
                        rootUri + 'local_callback.ts',
                        'function local(): void { function act(handle: () => void): void { handle() } }',
                    ],
                    [
                        rootUri + 'e.ts',
                        [
                            'import * as d from "./d";',
                            '',
                            'let i: d.I = { target: "hi" };',
                            'let target = i.target;',
                        ].join('\n'),
                    ],
                    [rootUri + 'foo/f.ts', ['import {Foo} from "./b";', '', 'let foo: Foo = Object({});'].join('\n')],
                    [rootUri + 'foo/g.ts', ['class Foo = {}', '', 'let foo: Foo = Object({});'].join('\n')],
                ])
            )
        )

        afterEach(shutdownService)

        describe('textDocumentEdefinition', () => {
            specify('in other file', async function(this: ExtendedTestContext & Context): Promise<void> {
                const result: SymbolLocator[] = await this.service
                    .textDocumentEdefinition({
                        textDocument: {
                            uri: rootUri + 'foo/c.ts',
                        },
                        position: {
                            line: 0,
                            character: 9,
                        },
                    })
                    .reduce<Operation, SymbolLocator[]>(applyReducer, null as any)
                    .toPromise()
                assert.deepEqual(result, [
                    {
                        location: {
                            uri: rootUri + 'foo/b.ts',
                            range: {
                                start: {
                                    line: 1,
                                    character: 13,
                                },
                                end: {
                                    line: 1,
                                    character: 16,
                                },
                            },
                        },
                        package: undefined,
                        path: 'foo/b.ts',
                        qname: 'foo.b.Foo',
                        symbolKind: 5,
                    },
                ])
            })
        })

        describe('textDocumentFull', () => {
            // TODO This test failed right now because it try to load system file when compute target (`console`)
            // specify('full a.ts', async function (this: ExtendedTestContext & Context): Promise<void> {
            //     const result: Full[] = await this.service
            //         .textDocumentFull({
            //             textDocument: {
            //                 uri: rootUri + 'a.ts',
            //             },
            //             reference: true
            //         })
            //         .reduce<Operation, Full[]>(applyReducer, null as any)
            //         .toPromise()
            //
            //     assert.deepEqual(result, [])
            // })
            //

            specify('full d.ts', async function(this: ExtendedTestContext & Context): Promise<void> {
                const result: Full[] = await this.service
                    .textDocumentFull({
                        textDocument: {
                            uri: rootUri + 'd.ts',
                        },
                        reference: true,
                    })
                    .reduce<Operation, Full[]>(applyReducer, null as any)
                    .toPromise()

                assert.deepEqual(result, [
                    {
                        symbols: [
                            {
                                qname: '"d"',
                                package: undefined,
                                symbolInformation: {
                                    name: '"d"',
                                    kind: 2,
                                    location: {
                                        uri: rootUri + 'd.ts',
                                        range: {
                                            start: {
                                                line: 0,
                                                character: 0,
                                            },
                                            end: {
                                                line: 2,
                                                character: 1,
                                            },
                                        },
                                    },
                                },
                                contents: '',
                            },
                            {
                                qname: 'd.I',
                                package: undefined,
                                symbolInformation: {
                                    name: 'I',
                                    kind: 11,
                                    location: {
                                        uri: rootUri + 'd.ts',
                                        range: {
                                            start: {
                                                line: 0,
                                                character: 0,
                                            },
                                            end: {
                                                line: 2,
                                                character: 1,
                                            },
                                        },
                                    },
                                    containerName: '"d"',
                                },
                                contents: '',
                            },
                            {
                                qname: 'I.target',
                                package: undefined,
                                symbolInformation: {
                                    name: 'target',
                                    kind: 7,
                                    location: {
                                        uri: rootUri + 'd.ts',
                                        range: {
                                            start: {
                                                line: 1,
                                                character: 2,
                                            },
                                            end: {
                                                line: 1,
                                                character: 17,
                                            },
                                        },
                                    },
                                    containerName: 'I',
                                },
                                contents: [
                                    {
                                        language: 'typescript',
                                        value: 'I.target: string',
                                    },
                                    '**property**',
                                ],
                            },
                        ],
                        references: [
                            {
                                category: 0,
                                target: {
                                    qname: 'd.I',
                                    package: undefined,
                                    symbolKind: 11,
                                    path: 'd.ts',
                                    location: {
                                        uri: rootUri + 'd.ts',
                                        range: {
                                            start: {
                                                line: 0,
                                                character: 17,
                                            },
                                            end: {
                                                line: 0,
                                                character: 18,
                                            },
                                        },
                                    },
                                },
                                location: {
                                    uri: rootUri + 'd.ts',
                                    range: {
                                        start: {
                                            line: 0,
                                            character: 16,
                                        },
                                        end: {
                                            line: 0,
                                            character: 18,
                                        },
                                    },
                                },
                            },
                        ],
                    },
                ])
            })
        })
    })
}
