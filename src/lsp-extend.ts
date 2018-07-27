import { Location, MarkedString, MarkupContent, SymbolInformation, TextDocumentIdentifier } from 'vscode-languageserver'

export interface FullParams {
    textDocument: TextDocumentIdentifier
}

export interface DetailSymbolInformation {
    symbolInformation: SymbolInformation
    // Use for hover
    contents?: MarkupContent | MarkedString | MarkedString[]
}

export enum ReferenceCategory {
    UNCATEGORIZED,
    READ,
    WRITE,
    INHERIT,
    IMPLEMENT,
}

export interface Reference {
    category: ReferenceCategory
    location: Location
    symbol: SymbolInformation
}

export interface SymbolLocator {
    name: string
    containerName?: string
    filePath: string
}

export interface Full {
    symbols: DetailSymbolInformation[] | null
    references: Reference[] | null
}
