import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { resolve } from 'path'

export class DependencyManager {
    private rootPath: string;

    constructor(
        rootPath: string,
    ) {
        this.rootPath = rootPath
    }

    public installDependency(): void {
        try {
            this.runNpm()
        } catch (e) {
            console.debug(e)
        }

        // TO check if this is neccessary if we just download deps inside the workspace
        // await Promise.all(iterare.default(this.packageManager.packageJsonUris()).map(
        //     async uri => {
        //         console.log(uri)
        //     }
        // ))
    }

    public shutdown(): void {
        // TODO check the best way to kill
        // TODO is this sync or async
        // console.debug('shutdowwn')
        // this.npmProcess.kill('SIGKILL')
    }

    public runNpm(): void {
        const env = Object.create(process.env);
        env.TERM = 'dumb';

        const cwd = this.rootPath;
        let cmd = 'yarn';

        if (existsSync(resolve(cwd, 'package-lock.json'))) {
            cmd = 'npm'
        }

        // this.npmProcess =
        spawnSync(
            cmd,
            [
                'install',
                '--json',
                '--ignore-scripts', // no user script will be run
                '--no-progress', // don't show progress
                '--ignore-engines', // ignore "incompatible module" error
            ],
            {
                env,
                cwd,
                stdio: 'inherit',
            }
        )

        // this.npmProcess.stdout.on('data', data => {
        //     console.debug('stdout: ' + data)
        // })
        //
        // this.npmProcess.stderr.on('data', data => {
        //     console.debug('stderr:' + data)
        // })
        //
        // this.npmProcess.on('error', err => {
        //     console.debug('error:' + err)
        // })
    }
}
