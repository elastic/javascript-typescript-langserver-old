import { Logger } from 'javascript-typescript-langserver/lib/logging';
import { InMemoryFileSystem, typeScriptLibraries} from 'javascript-typescript-langserver/lib/memfs';
import {path2uri, uri2path} from 'javascript-typescript-langserver/lib/util';

import { join } from 'path'

import * as ts from 'typescript'

export class PatchedInMemoryFileSystem extends InMemoryFileSystem {
    private log: Logger;
    private readonly rootUri: string;

    constructor(path: string, logger: Logger) {
        super(path, logger);
        this.rootUri = path2uri(path);
        this.log = logger;
    }

    public readFile(path: string): string {
        const content = this.readFileIfExistsOverwrite(path)
        if (content === undefined) {
            // @ts-ignore
            // this.logger.info(`readFile ${path} requested by TypeScript but content not available`)
            if (path.endsWith('.min.js') || path.endsWith('bundle.js')) {
                return '';
            }

            const content = ts.sys.readFile(path, 'utf8'); // fs.readFileSync(path, 'utf8')
            const uri = path2uri(path);

            if (!uri.startsWith(this.rootUri) && uri.indexOf(join('node_modules', 'typescript')) === -1) {
                this.log.error('File ' + uri + ' out of root path');
            } else {
                this.add(uri, content)
            }

            return content!
        }
        return content
    }

    public getContent(uri: string): string {
        let content = this.overlay.get(uri)
        if (content === undefined) {
            // @ts-ignore
            if (this.files.has(uri)) {
                // @ts-ignore
                content = this.files.get(uri);
                if (content === undefined) {
                    content = ts.sys.readFile(uri2path(uri), 'utf8');
                }
            }
        }
        if (content === undefined) {
            content = typeScriptLibraries.get(uri2path(uri))
        }
        if (content === undefined) {
            throw new Error(`Content of ${uri} is not available in memory`)
        }
        return content
    }

    public add(uri: string, content?: string): void {
        // if (!uri.endsWith('.js') && !uri.endsWith('.ts') && !uri.endsWith(''))
        // if (uri.endsWith('.min.js') || uri.endsWith('bundle.js')) {
        //     return;
        // }
        if (uri.endsWith('package.json') || uri.endsWith('tsconfig.json')) {
            super.add(uri, content);
        } else if (uri.endsWith('.js') || uri.endsWith('.ts') || uri.endsWith('.jsx') || uri.endsWith('.tsx')) {
            super.add(uri, undefined);
        }
    }

    /**
     * @param path file path (both absolute or relative file paths are accepted)
     * @return file's content in the following order (overlay then cache).
     * If there is no such file, returns undefined
     */
    private readFileIfExistsOverwrite(path: string): string | undefined {
        const uri = path2uri(path)
        let content = this.overlay.get(uri)
        if (content !== undefined) {
            return content
        }

        // TODO This assumes that the URI was a file:// URL.
        //      In reality it could be anything, and the first URI matching the path should be used.
        //      With the current Map, the search would be O(n), it would require a tree to get O(log(n))
        // @ts-ignore
        content = this.files.get(uri)
        if (content !== undefined) {
            return content
        }

        return typeScriptLibraries.get(path)
    }

}
