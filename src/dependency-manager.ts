
import { spawn, ChildProcess } from 'child_process'
import { ProjectManager } from "javascript-typescript-langserver/lib/project-manager";
import {PackageManager} from "javascript-typescript-langserver/lib/packages";
import * as iterare from 'iterare'
import {InMemoryFileSystem} from "javascript-typescript-langserver/lib/memfs";  // TODO srcgraph uses this pattern in the repo, not sure if there is a better way

export class DependencyManager {
    private projectManager: ProjectManager;
    private packageManager: PackageManager;
    private inMemoryFileSystem: InMemoryFileSystem;
    private npmProcess: ChildProcess;

    constructor(projectManager: ProjectManager, packageManager: PackageManager, inMemoryFileSystem: InMemoryFileSystem) {
        this.projectManager = projectManager;
        this.packageManager = packageManager;
        this.inMemoryFileSystem = inMemoryFileSystem;
         // Touch inMemoryFileSystem to pass lint. TODO(fuyao): remove this line.
        this.inMemoryFileSystem.has('');
    }

    public async installDependency() {
        console.log("install")
        this.runNpm()

        // TO check if this is neccessary if we just download deps inside the workspace
        await Promise.all(iterare.default(this.packageManager.packageJsonUris()).map(
            async uri => {
                console.log(uri)
            }
        ))

        this.projectManager.invalidateModuleStructure();
        this.projectManager.ensureModuleStructure();
    }

    public shutdown() {
        // TODO check the best way to kill
        // TODO is this sync or async
        // this.npmProcess.kill('SIGKILL')

        this.npmProcess
    }

    public runNpm() {
        // TODO figure out how to ensure yarn installed
        // TODO figure out where is the CWD to run the child process
        console.log("spawn")

        // const child = spawnSync("yarn", [ "install", "--json", "--ignore-scripts" ], { env: { TERM: "dumb" }})
        //
        // return child;

        let env = Object.create( process.env );
        env.TERM = 'dumb'


        const child = spawn("yarn", [ "install", "--json", "--ignore-scripts", "--no-progress" ],
            { env, cwd: "/Users/fuyaoz/codesearch/data/repos/github.com/Microsoft/TypeScript-Node-Starter" })
        // TODO remove hard code

        console.log("after spawn")

        child.stdout.on('data', data => {
            console.log('stdout: ' + data)
            // TODO process the data
        });

        child.stderr.on('data', data => {
            // console.log("stderr:" + data)
        })

        child.on('error', err => {
            // console.log("error:" + err)
        });


        return child
    }
}
