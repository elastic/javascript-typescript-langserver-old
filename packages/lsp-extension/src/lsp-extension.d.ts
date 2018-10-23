import { Location, MarkedString, MarkupContent, SymbolInformation, SymbolKind, TextDocumentIdentifier } from 'vscode-languageserver-protocol'

// Same as request-type/PackageDescriptor
export interface PackageLocator {
    // PackageName could be different than repoName
    name?: string

    // Uri and revision of the symbol repository, should be non-empty for js, python, ruby, etc
    // But the version are not always valid because some single repo could publish to different package,
    // e.g. typescript, definitedType, then we still need to reply on qname plus repoUri to locate
    version?: string
    repoUri?: string
}

export interface FullParams {
    textDocument: TextDocumentIdentifier
    reference?: boolean
}

export interface DetailSymbolInformation {
    symbolInformation: SymbolInformation
    qname?: string
    // Use for hover
    contents?: MarkupContent | MarkedString | MarkedString[]
    package?: PackageLocator
}

export enum ReferenceCategory {
    UNCATEGORIZED,
    READ,
    WRITE,
    INHERIT,
    IMPLEMENT,
}

export interface SymbolLocator {
    qname?: string
    symbolKind?: SymbolKind

    // In repo file path for the symbol, TODO we may not need this because if qname could serve its purpose
    path?: string

    // if a is provided (especially in local repo), then use this
    location?: Location

    package?: PackageLocator
}

export interface Reference {
    category: ReferenceCategory
    location: Location
    /** @deprecated */
    symbol?: SymbolInformation
    target: SymbolLocator
}

export interface Full {
    symbols: DetailSymbolInformation[] | null
    references: Reference[] | null
}
