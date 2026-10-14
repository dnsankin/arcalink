import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../.cache/source/',import.meta.url));
export default {
 root,
 resolve:{alias:{'@/localized-obsidian':fileURLToPath(new URL('./content-retry-ui-stub.ts',import.meta.url)),'@':root+'src'}},
 test:{environment:'node',include:['src/content-retry.integration.unit.spec.ts','src/serviceFeatures/replication/*.unit.spec.ts']},
};
