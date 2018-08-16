import { Location, MarkedString, MarkupContent, SymbolInformation, TextDocumentIdentifier } from 'vscode-languageserver/lib/main'

export interface FullParams {
    textDocument: TextDocumentIdentifier
}

export interface DetailSymbolInformation {
    symbolInformation: SymbolInformation
    // Use for hover
    contents?: MarkupContent | MarkedString | MarkedString[]
    repoUri?: string
    revision?: string
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

export interface Full {
    symbols: DetailSymbolInformation[] | null
    references: Reference[] | null
}
