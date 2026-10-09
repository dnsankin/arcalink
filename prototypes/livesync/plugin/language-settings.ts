import {Notice,Setting} from 'obsidian';
import {setLang} from './common/translation';
import {localizeMessage} from './localized-obsidian';

export function renderLanguageSetting(el:HTMLElement,setting:any,refresh:()=>void){
  new Setting(el).setName(localizeMessage('Interface language'))
    .setDesc(localizeMessage('Choose the language for ArcaLink settings and notifications.'))
    .addDropdown(dropdown=>{
      dropdown.addOption('',localizeMessage('Same as Obsidian')).addOption('ru','Русский').addOption('def','English');
      const selected=setting.currentSettings().displayLanguage||'';
      // Preserve a language previously selected in the engine's advanced settings.
      if(!['','ru','def'].includes(selected))dropdown.addOption(selected,selected);
      dropdown.setValue(selected).onChange(async value=>{
        const previous=setting.currentSettings().displayLanguage;
        if(value===(previous||''))return;
        dropdown.setDisabled(true);
        try{
          await setting.applyPartial({displayLanguage:value},true);
        }catch{
          setting.currentSettings().displayLanguage=previous;
          setLang(previous||'');
          dropdown.setValue(previous||'');
          new Notice('Could not save the interface language. Try again.');
          return;
        }finally{dropdown.setDisabled(false);}
        setLang(value as Parameters<typeof setLang>[0]);
        refresh();
      });
    });
}
