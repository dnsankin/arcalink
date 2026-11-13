/** A typed revision is a safety marker, not an authorization or receipt. */
export const ACTION_REVISION_PREFIX='a7ca11a6c7100001';
export function isActionRevision(revision){return typeof revision==='string'&&/^[1-9][0-9]*-a7ca11a6c7100001[a-f0-9]{64}$/.test(revision);}
export function effectiveFileSettings(settings,document,force=false,allowExistingConflicts=false){
 return !force&&!allowExistingConflicts&&isActionRevision(document?._rev)?{...settings,writeDocumentsIfConflicted:false}:settings;
}
