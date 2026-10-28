import {Modal, Notice, Setting, TFolder, type App, type ToggleComponent} from 'obsidian';
import {excludedFolders, folderContains, withExcludedFolders,excludedLocalFolderRoots,localFolderCleanupBlock,trashExcludedLocalFolder} from './folder-exclusions.mjs';
import {FolderRulesModal,renderCommonFolderStatus} from './folder-rules-ui';
import {localizeMessage} from './localized-obsidian';

export function renderFolderExclusions(el:HTMLElement, pilot:any) {
  const service=pilot.core.services.setting;
  const row=new Setting(el).setName('Исключённые папки');
  const cleanup=el.createDiv();
  const refresh=()=>{
    const count=excludedFolders(service.currentSettings().syncIgnoreRegEx||'').length;
    renderLocalFolderCleanup(cleanup,pilot);
    row.setDesc(pilot.folderPolicies?.available?'Локальные исключения: '+count+'. Общие исключения: '+(pilot.folderPolicies.state?.policy?.folders?.length||0)+'.':'Выбрано папок: '+count+'. Выбор действует только на этом устройстве.');
  };
  refresh();
  renderCommonFolderStatus(el,pilot);
  row.addButton(button=>button.setButtonText('Выбрать папки').onClick(()=>{
    if(pilot.folderPolicies)new FolderRulesModal(pilot,refresh).open();
    else new FolderExclusionsModal(pilot.app,service,async()=>{
      if(pilot.workspaces.busy||await pilot.workspaces.pendingMerge())throw Error('Сначала завершите слияние хранилищ');
    },refresh).open();
  }));
}

function renderLocalFolderCleanup(el:HTMLElement,pilot:any) {
  el.empty();
  el.addClass('arcalink-folder-access-card','arcalink-local-folder-cleanup');
  const snapshot=()=>{
    const settings=pilot.core.services.setting.currentSettings();
    const policy=pilot.folderPolicies;
    return {rules:settings.syncIgnoreRegEx||'',caseSensitive:!!settings.handleFilenameCaseSensitive,
      common:policy?.importReady?.()&&!policy?.remoteOperation?(policy.state?.policy?.folders||[]):[],
      paths:pilot.app.vault.getAllLoadedFiles().filter((file:any)=>file instanceof TFolder&&file.path&&file.path!=='/').map((file:any)=>file.path),
      shared:(pilot.folders?.records||[]).map((record:any)=>record.mount),
      protectedPaths:[pilot.app.vault.configDir,pilot.pilotDirectory].filter(Boolean)};
  };
  const state=snapshot(),paths=excludedLocalFolderRoots(state);
  new Setting(el).setName('Локальные копии исключённых папок')
    .setDesc('Удаление перемещает папку в корзину Obsidian на этом устройстве. Правило исключения сохраняется. Облачные копии и другие устройства не удаляются.')
    .addButton(button=>button.setButtonText('Обновить список').onClick(()=>renderLocalFolderCleanup(el,pilot)));
  if(!paths.length){el.createEl('p',{text:localizeMessage('На этом устройстве нет локальных копий исключённых папок.')});return;}
  for(const path of paths){
    const blocked=localFolderCleanupBlock(path,state);
    const row=new Setting(el);row.nameEl.createSpan({text:path,attr:{'data-arcalink-user-content':''}});
    if(blocked)row.setDesc(blocked);
    row.addButton(button=>button.setButtonText('Удалить локальную копию').setDisabled(!!blocked).onClick(()=>{
      const modal=new Modal(pilot.app);modal.titleEl.setText(localizeMessage('Удалить локальную копию папки?'));
      modal.contentEl.createEl('p',{text:path,attr:{'data-arcalink-user-content':''}});
      modal.contentEl.createEl('p',{text:localizeMessage('Папка со всем содержимым будет перемещена в корзину Obsidian на этом устройстве. Исключение из синхронизации останется включённым. Серверные копии и файлы других устройств не удаляются.')});
      const error=modal.contentEl.createEl('p');
      new Setting(modal.contentEl).addButton(cancel=>cancel.setButtonText('Отмена').onClick(()=>modal.close()))
        .addButton(confirm=>confirm.setButtonText('Удалить локальную копию').setWarning().onClick(async()=>{
          confirm.setDisabled(true);error.setText('');
          try{
            if(pilot.workspaces.busy||await pilot.workspaces.pendingMerge())throw Error('Сначала завершите слияние хранилищ');
            await trashExcludedLocalFolder(path,{snapshot,getFolder:(name:string)=>{const file=pilot.app.vault.getAbstractFileByPath(name);return file instanceof TFolder?file:null;},trash:(folder:any)=>pilot.app.vault.trash(folder,false)});
            new Notice('Локальная папка перемещена в корзину Obsidian. Исключение сохранено.');
            modal.close();renderLocalFolderCleanup(el,pilot);
          }catch(e:any){error.setText(e.message||'Не удалось удалить локальную копию папки.');}
          finally{confirm.setDisabled(false);}
        }));
      modal.open();
    }));
  }
}

export class FolderExclusionsModal extends Modal {
  constructor(app:App,private service:any,private beforeSave:()=>Promise<void>,private saved:()=>void) {super(app);}
  override onOpen() {
    this.titleEl.setText(localizeMessage('Исключённые папки'));
    const initial=this.service.currentSettings();
    const original=initial.syncIgnoreRegEx||'';
    const caseSensitive=!!initial.handleFilenameCaseSensitive;
    const selected=new Set<string>(excludedFolders(original));
    const available=this.app.vault.getAllLoadedFiles().filter((file):file is TFolder=>file instanceof TFolder&&file.path!==''&&file.path!=='/').map(folder=>folder.path);
    const paths=[...new Set([...available,...selected])].sort((a,b)=>a.localeCompare(b));
    this.contentEl.createEl('p',{text:localizeMessage('Выбранные папки и все их вложенные папки будут пропускаться при синхронизации личного хранилища на этом устройстве. Настройте исключения отдельно на остальных устройствах. Общие папки и совместные заметки управляются отдельно.')});
    this.contentEl.createEl('p',{text:localizeMessage('Исключение не удаляет локальные файлы или прежнюю серверную копию и не освобождает уже занятое место. Ранее отправленные данные могут оставаться в служебной базе и передаваться между устройствами.')});
    if(withExcludedFolders(original,[],caseSensitive))this.contentEl.createEl('p',{text:localizeMessage('Также действуют ранее заданные дополнительные фильтры. Здесь они не изменяются.')});
    let query='',busy=false;
    let noResults:HTMLElement|undefined;
    const controls:{path:string,row:Setting,toggle:ToggleComponent}[]=[];
    const count=this.contentEl.createEl('p');
    const update=()=>{
      count.setText(localizeMessage('Выбрано папок: '+excludedFolders(withExcludedFolders('',[...selected],caseSensitive)).length));
      for(const item of controls){
        item.row.settingEl.hidden=!!query&&!item.path.toLocaleLowerCase().includes(query);
        const covered=[...selected].some(parent=>folderContains(parent,item.path,caseSensitive));
        const inherited=[...selected].some(parent=>parent.length<item.path.length&&folderContains(parent,item.path,caseSensitive));
        item.toggle.setValue(covered).setDisabled(busy||inherited);
      }
      if(noResults)noResults.hidden=controls.some(item=>!item.row.settingEl.hidden);
    };
    let search:any,clear:any,save:any,cancel:any;
    new Setting(this.contentEl).setName('Поиск папок').addText(text=>{
      search=text;text.setPlaceholder(localizeMessage('Часть пути папки')).onChange(value=>{query=value.toLocaleLowerCase();update();});
    });
    new Setting(this.contentEl).addButton(button=>{clear=button;button.setButtonText('Снять выбор папок').onClick(()=>{selected.clear();update();});});
    const list=this.contentEl.createDiv();list.style.maxHeight='40vh';list.style.overflowY='auto';
    if(!paths.length)list.createEl('p',{text:localizeMessage('В хранилище пока нет папок.')});
    for(const path of paths){
      const row=new Setting(list);
      row.nameEl.createSpan({text:path,attr:{'data-arcalink-user-content':''}});
      if(!available.includes(path))row.setDesc('Папка отсутствует на этом устройстве; исключение сохранено.');
      row.addToggle(toggle=>{
        controls.push({path,row,toggle});
        toggle.toggleEl.setAttribute('data-arcalink-user-content','');
        toggle.toggleEl.setAttribute('aria-label',path);
        toggle.onChange(value=>{
          for(const old of selected)if(folderContains(path,old,caseSensitive))selected.delete(old);
          if(value)selected.add(path);
          update();
        });
      });
    }
    if(paths.length)noResults=list.createEl('p',{text:localizeMessage('Подходящие папки не найдены.')});
    new Setting(this.contentEl)
      .addButton(button=>{cancel=button;button.setButtonText('Отмена').onClick(()=>this.close());})
      .addButton(button=>{save=button;button.setButtonText('Сохранить').setCta().onClick(async()=>{
        if(busy)return;
        busy=true;search.setDisabled(true);clear.setDisabled(true);save.setDisabled(true);cancel.setDisabled(true);update();
        let applied:string|undefined;
        let persisted=false;
        try{
          await this.beforeSave();
          const current=this.service.currentSettings();
          if((current.syncIgnoreRegEx||'')!==original||!!current.handleFilenameCaseSensitive!==caseSensitive){
            new Notice('Настройки исключений изменились. Закройте окно и откройте выбор папок заново.');return;
          }
          const next=withExcludedFolders(original,[...selected],caseSensitive);
          if(next!==original){applied=next;await this.service.applyPartial({syncIgnoreRegEx:next},true);}
          persisted=true;
          this.saved();this.close();
        }catch(e:any){
          // applyPartial updates memory before saving. Restore only our own
          // failed edit; never overwrite a concurrent settings change.
          if(!persisted&&applied!==undefined&&this.service.currentSettings().syncIgnoreRegEx===applied)this.service.currentSettings().syncIgnoreRegEx=original;
          new Notice(e.message==='Сначала завершите слияние хранилищ'?e.message:'Не удалось сохранить исключения папок. Повторите попытку.');
        }finally{
          busy=false;search.setDisabled(false);clear.setDisabled(false);save.setDisabled(false);cancel.setDisabled(false);update();
        }
      });});
    update();
  }
  override onClose(){this.contentEl.empty();}
}
