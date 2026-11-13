// Settings must remain reachable when a later readiness/policy guard rejects
// synchronisation. This changes only registration of the settings tab.
export function patchSettingsRegistration(source) {
 source=source.replace('services.appLifecycle.onSettingLoaded.addHandler(this._everyOnloadAfterLoadSettings.bind(this), -100);','services.appLifecycle.onSettingLoaded.addHandler(this._everyOnloadAfterLoadSettings.bind(this));');
 const original='services.appLifecycle.onSettingLoaded.addHandler(this._everyOnloadAfterLoadSettings.bind(this));';
 const patched='services.appLifecycle.onSettingLoaded.addHandler(this._everyOnloadAfterLoadSettings.bind(this), -11000);';
 if(source.includes(patched)&&!source.includes(original))return source;
 if(source.split(original).length!==2)throw Error('Unexpected upstream settings registration');
 return source.replace(original,patched);
}
