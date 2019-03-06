import {InMemoryFileSystem, typeScriptLibraries} from 'javascript-typescript-langserver/lib/memfs';
import {path2uri} from 'javascript-typescript-langserver/lib/util';

import * as fs from 'fs'

export class PatchedInMemoryFileSystem extends InMemoryFileSystem {

    public readFile(path: string): string {
        const content = this.readFileIfExistsOverwrite(path)
        if (content === undefined) {
            // @ts-ignore
            // this.logger.info(`readFile ${path} requested by TypeScript but content not available`)

            const content = fs.readFileSync(path, 'utf8')
            this.add(path2uri(path), content)
            return content
        }
        return content
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
