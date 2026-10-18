export const FOLDER_LAB_ID='arcalink-folders-lab';
export const FOLDER_LAB_BASE='https://arcalink.ru/sync-lab/folders';
export function pluginEnvironment(manifest) {
  const lab=manifest?.id===FOLDER_LAB_ID;
  return {lab,folderPolicies:lab||manifest?.id==='arcalink-sync',api:lab?FOLDER_LAB_BASE+'/api':manifest?.id==='arcalink-free-lab'?'https://arcalink.ru/sync-lab/unified/api':'https://arcalink.ru/sync/api',
    freeBase:lab?FOLDER_LAB_BASE+'/free':'https://arcalink.ru/sync-lab/free',
    freeSignal:lab?'wss://arcalink.ru/sync-lab/folders/free/signal':'wss://arcalink.ru/sync-lab/free/signal'};
}
