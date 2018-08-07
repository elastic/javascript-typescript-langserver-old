
import { spawn, ChildProcess } from 'child_process'
import { ProjectManager } from "javascript-typescript-langserver/lib/project-manager";
import {PackageManager} from "javascript-typescript-langserver/lib/packages";
import {InMemoryFileSystem} from "javascript-typescript-langserver/lib/memfs";  // TODO srcgraph uses this pattern in the repo, not sure if there is a better way

export class DependencyManager {
    private projectManager: ProjectManager;
    // @ts-ignore
    private packageManager: PackageManager;
    // @ts-ignore
    private inMemoryFileSystem: InMemoryFileSystem;
    private npmProcess: ChildProcess;

    constructor(projectManager: ProjectManager, packageManager: PackageManager, inMemoryFileSystem: InMemoryFileSystem) {
        this.projectManager = projectManager;
        this.packageManager = packageManager;
        this.inMemoryFileSystem = inMemoryFileSystem;
    }

    public async installDependency() {
        console.log("install")
        this.runNpm()

        // TO check if this is neccessary if we just download deps inside the workspace
        // await Promise.all(iterare.default(this.packageManager.packageJsonUris()).map(
        //     async uri => {
        //         console.log(uri)
        //     }
        // ))

        this.projectManager.invalidateModuleStructure();
        this.projectManager.ensureModuleStructure();
    }

    public shutdown() {
        // TODO check the best way to kill
        // TODO is this sync or async
        console.log("shutdowwn")
        this.npmProcess.kill('SIGKILL')
    }

    public runNpm() {
        console.log("spawn")

        let env = Object.create( process.env );
        env.TERM = 'dumb'

        this.npmProcess = spawn("yarn", [
            "install", "--json",
            "--ignore-scripts", // no user script will be run
            "--no-progress", // don't show progress
            "--ignore-engines" // ignore "incompatible module" error
            ],
            { env, cwd:  this.projectManager.getRemoteRoot() })

        this.npmProcess.stdout.on('data', data => {
            console.debug('stdout: ' + data)
        });

        this.npmProcess.stderr.on('data', data => {
            console.debug("stderr:" + data)
        })

        this.npmProcess.on('error', err => {
            console.debug("error:" + err)
        });
    }
}
