/** Continue the ordinary lifecycle after the ownership gate, without reloading plugin code. */
export function createCompanionResume(core, wasStartupBlocked) {
 let pending;
 return () => pending ??= (async()=>{
  const s=core.services;
  if(wasStartupBlocked()){
   // Wire-up and initialisation already ran before the ownership gate. Do not repeat them.
   if(!await s.appLifecycle.onSettingLoaded())throw Error('ownership-resume-settings-blocked');
   await s.database.openDatabase({databaseEvents:s.databaseEvents,replicator:s.replicator});
   if(await s.appLifecycle.onLoaded()===false)throw Error('ownership-resume-load-blocked');
   await Promise.all(core.addOns.map(addOn=>Promise.resolve(addOn.onload())));
   if(!await s.control.onReady())throw Error('ownership-resume-ready-blocked');
  }else{
   // The existing engine and event subscriptions survived the temporary hold.
   await s.control.applySettings();
  }
  return true;
 })();
}
