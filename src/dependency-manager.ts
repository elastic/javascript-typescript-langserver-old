import { ChildProcess, spawn } from 'child_process'
import { existsSync } from 'fs'
import { resolve } from 'path'

import { InMemoryFileSystem } from 'javascript-typescript-langserver/lib/memfs' // TODO srcgraph uses this pattern in the repo, not sure if there is a better way
import { PackageManager } from 'javascript-typescript-langserver/lib/packages'
import { ProjectManager } from 'javascript-typescript-langserver/lib/project-manager'

export class DependencyManager {
    private projectManager: ProjectManager
    // @ts-ignore
    private packageManager: PackageManager
    // @ts-ignore
    private inMemoryFileSystem: InMemoryFileSystem
    private npmProcess: ChildProcess

    constructor(
        projectManager: ProjectManager,
        packageManager: PackageManager,
        inMemoryFileSystem: InMemoryFileSystem
    ) {
        this.projectManager = projectManager
        this.packageManager = packageManager
        this.inMemoryFileSystem = inMemoryFileSystem
    }

    public async installDependency(): Promise<void> {
        this.runNpm()

        // TO check if this is neccessary if we just download deps inside the workspace
        // await Promise.all(iterare.default(this.packageManager.packageJsonUris()).map(
        //     async uri => {
        //         console.log(uri)
        //     }
        // ))

        this.projectManager.invalidateModuleStructure()
        this.projectManager.ensureModuleStructure()
    }

    public shutdown(): void {
        // TODO check the best way to kill
        // TODO is this sync or async
        console.debug('shutdowwn')
        this.npmProcess.kill('SIGKILL')
    }

    public runNpm(): void {
        const env = Object.create(process.env)
        env.TERM = 'dumb'

        const cwd = this.projectManager.getRemoteRoot()
        let cmd = 'yarn'

        if (existsSync(resolve(cwd, 'package-lock.json'))) {
            cmd = 'npm'
        }

        this.npmProcess = spawn(
            cmd,
            [
                'install',
                '--json',
                '--ignore-scripts', // no user script will be run
                '--no-progress', // don't show progress
                '--ignore-engines', // ignore "incompatible module" error
            ],
            { env, cwd }
        )

        this.npmProcess.stdout.on('data', data => {
            console.debug('stdout: ' + data)
        })

        this.npmProcess.stderr.on('data', data => {
            console.debug('stderr:' + data)
        })

        this.npmProcess.on('error', err => {
            console.debug('error:' + err)
        })
    }
}
