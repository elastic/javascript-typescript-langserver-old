import { ExtendedTypescriptService } from '../extended-typescript-service'
import { describeTypeScriptService } from './extended-typescript-service-helpers'

describe('ExtendedTypeScriptService', () => {
    for (const rootUri of ['file:///foo/bar/']) {
        describe(`rootUri ${rootUri}`, () => {
            describeTypeScriptService(
                (client, options) => new ExtendedTypescriptService(client, options),
                undefined,
                rootUri
            )
        })
    }
})
