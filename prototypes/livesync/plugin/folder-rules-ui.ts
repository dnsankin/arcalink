import {Modal,Notice,Setting,TFolder,type App} from 'obsidian';
import {excludedFolders,folderContains,withExcludedFolders} from './folder-exclusions.mjs';
import {localizeMessage} from './localized-obsidian';

function confirmChange(app:App,plan:any,removed:boolean):Promise<boolean>{
  return new Promise(resolve=>{
    class Confirm extends Modal {
      answered=false;
      override onOpen(){
        this.titleEl.setText(localizeMessage('Изменить общие исключения?'));
        for(const folder of plan.folders)this.contentEl.createEl('p',{text:folder,attr:{'data-arcalink-user-content':''}});
        this.contentEl.createEl('p',{text:localizeMessage('Будут удалены только облачные копии выбранных папок. Локальные файлы на всех устройствах сохранятся. Обмен этими папками будет отключён везде.')});
        new Setting(this.contentEl).setName('Файлов в облачной копии').setDesc(String(plan.fileCount));
        new Setting(this.contentEl).setName('Объём текущих файлов').setDesc((plan.logicalBytes/1024/1024).toFixed(1)+' МБ');
        this.contentEl.createEl('p',{text:localizeMessage('Это объём файлов, а не обещание точного освобождения места. Дождитесь окончания очистки.')});
        if(removed)this.contentEl.createEl('p',{text:localizeMessage('Вы снимаете общее исключение. Локальные копии смогут снова загрузиться в облако. Независимые локальные исключения других устройств сохранятся.')});
        new Setting(this.contentEl).addButton(b=>b.setButtonText('Отмена').onClick(()=>{this.answered=true;resolve(false);this.close();}))
          .addButton(b=>b.setButtonText('Подтвердить изменение').setWarning().onClick(()=>{this.answered=true;resolve(true);this.close();}));
      }
      override onClose(){if(!this.answered)resolve(false);this.contentEl.empty();}
    }
    new Confirm(app).open();
  });
}

export class FolderRulesModal extends Modal {
  closed=false;busy=false;confirmed=false;
  constructor(private pilot:any,private saved:()=>void){super(pilot.app);}
  override onOpen(){
    const controller=this.pilot.folderPolicies,service=this.pilot.core.services.setting,initial=service.currentSettings();
    const original=initial.syncIgnoreRegEx||'',caseSensitive=!!initial.handleFilenameCaseSensitive;
    const local=new Set<string>(excludedFolders(original)),common=new Set<string>(controller.state?.policy?.folders||[]);
    const globalCase=controller.state?.revision?!!controller.state.policy.caseSensitive:caseSensitive,revision=controller.state?.revision||0;
    const initialCommon=[...common];
    this.titleEl.setText(localizeMessage('Исключённые папки'));
    this.contentEl.createEl('p',{text:localizeMessage('Для каждой папки выберите область исключения. Локальный режим действует на этом устройстве. Общий режим удаляет облачную копию и отключает обмен папкой на всех устройствах. Локальные файлы сохраняются.')});
    this.contentEl.createEl('p',{text:localizeMessage('Общие папки и совместные заметки управляются отдельно. Удаление облачной копии личной папки не удаляет исходные сообщения и файлы в Telegram.')});
    const available=this.app.vault.getAllLoadedFiles().filter((f:any)=>f instanceof TFolder&&f.path&&f.path!=='/').map((f:any)=>f.path);
    const paths=[...new Set<string>([...available,...local,...common])].sort((a,b)=>a.localeCompare(b));
    let query='';const rows:any[]=[];let search:any,save:any,cancel:any;
    const list=this.contentEl.createDiv();list.style.maxHeight='45vh';list.style.overflowY='auto';
    const update=()=>{
      for(const {path,row,control} of rows){
        const parent=[...common].some(root=>root.length<path.length&&folderContains(root,path,globalCase));
        row.settingEl.hidden=!!query&&!path.toLocaleLowerCase().includes(query);
        control.setValue(common.has(path)||parent?'global':local.has(path)?'local':'none').setDisabled(this.busy||parent);
        if(parent)row.setDesc('Унаследовано от общей папки выше. Измените правило родительской папки.');
        else if(!available.includes(path))row.setDesc('Папка отсутствует на этом устройстве; исключение сохранено.');
        else row.setDesc('');
      }
    };
    new Setting(this.contentEl).setName('Поиск папок').addText(text=>{search=text;text.setPlaceholder(localizeMessage('Часть пути папки')).onChange(value=>{query=value.toLocaleLowerCase();update();});});
    this.contentEl.appendChild(list);
    for(const path of paths){
      const row=new Setting(list);row.nameEl.createSpan({text:path,attr:{'data-arcalink-user-content':''}});
      row.addDropdown(control=>{
        control.addOption('none',localizeMessage('Синхронизировать')).addOption('local',localizeMessage('Исключить на этом устройстве')).addOption('global',localizeMessage('Исключить везде и удалить из облака'));
        control.selectEl.setAttribute('data-arcalink-user-content','');control.selectEl.setAttribute('aria-label',path);
        control.onChange(value=>{
          local.delete(path);common.delete(path);
          if(value==='local')local.add(path);
          if(value==='global')common.add(path);
          update();
        });rows.push({path,row,control});
      });
    }
    if(!paths.length)list.createEl('p',{text:localizeMessage('В хранилище пока нет папок.')});
    const status=this.contentEl.createEl('p');
    new Setting(this.contentEl)
      .addButton(b=>{cancel=b;b.setButtonText('Отмена').onClick(()=>this.close());})
      .addButton(b=>{save=b;b.setButtonText('Сохранить').setCta().onClick(async()=>{
        if(this.busy)return;this.busy=true;search.setDisabled(true);save.setDisabled(true);cancel.setDisabled(true);update();
        let globalApplied=false;
        try{
          if(this.pilot.workspaces.busy||await this.pilot.workspaces.pendingMerge()||await this.pilot.workspaces.pendingMigration())throw Error('Сначала завершите слияние хранилищ');
          const stale=()=>(service.currentSettings().syncIgnoreRegEx||'')!==original||!!service.currentSettings().handleFilenameCaseSensitive!==caseSensitive;
          if(stale())throw Error('Настройки исключений изменились. Закройте окно и откройте выбор папок заново.');
          const roots=excludedFolders(withExcludedFolders('',[...common],globalCase));
          if(JSON.stringify(roots)!==JSON.stringify(initialCommon)){
            status.setText(localizeMessage('Рассчитываем облачную копию. Синхронизация временно приостановлена.'));
            const plan=await controller.preview(roots,revision);
            if(this.closed){await controller.cancelPreview();return;}
            const removed=initialCommon.some(old=>!roots.some(root=>folderContains(root,old,globalCase)));
            if(!await confirmChange(this.app,plan,removed)){await controller.cancelPreview();return;}
            if(this.closed){await controller.cancelPreview();return;}
            if(stale())throw Error('Настройки исключений изменились. Закройте окно и откройте выбор папок заново.');
            this.confirmed=true;status.setText(localizeMessage('Применяем общие исключения. Локальные файлы сохраняются.'));
            await controller.confirm(revision);globalApplied=true;
          }
          const next=withExcludedFolders(original,[...local],caseSensitive);
          if(next!==original){
            try{await service.applyPartial({syncIgnoreRegEx:next},true);}
            catch(error){if(service.currentSettings().syncIgnoreRegEx===next)service.currentSettings().syncIgnoreRegEx=original;throw error;}
          }
          this.saved();this.close();if(globalApplied)controller.reload();
        }catch(error:any){
          if(!this.confirmed)await controller.cancelPreview().catch(()=>{});
          if(this.closed&&error.code==='folder-preview-cancelled'&&!controller.holding)return;
          new Notice(globalApplied?'Общие исключения сохранены, но локальные настройки записать не удалось. Повторите локальный выбор папок.':error.message||'Не удалось сохранить исключения папок. Повторите попытку.');
          if(globalApplied)controller.reload();
        }finally{this.busy=false;search.setDisabled(false);save.setDisabled(false);cancel.setDisabled(false);update();}
      });});
    update();
  }
  override onClose(){this.closed=true;if(this.busy&&!this.confirmed)void this.pilot.folderPolicies.cancelPreview().catch(()=>{});this.contentEl.empty();}
}

export function renderCommonFolderStatus(el:HTMLElement,pilot:any){
  const controller=pilot.folderPolicies;
  if(!controller?.available&&!controller?.error)return;
  const row=new Setting(el).setName('Общие исключения');
  const refresh=()=>row.setDesc((controller.error||controller.remoteOperation)?'Изменение общих исключений ещё не завершено. Локальные файлы сохранены.':'Общие исключения применены на этом устройстве.');
  refresh();
  if(controller.remoteOperation||controller.operation){
    if(controller.remotePhase!=='preview')row.addButton(b=>b.setButtonText('Продолжить изменение').onClick(async()=>{b.setDisabled(true);try{await controller.resumeOperation();}catch(e:any){new Notice(e.message);}finally{b.setDisabled(false);}}));
    if(controller.remotePhase==='preview'||controller.operation&&!controller.operation.confirmed)row.addButton(b=>b.setButtonText('Отменить расчёт').onClick(async()=>{b.setDisabled(true);try{await controller.cancelPreview();refresh();}catch(e:any){new Notice(e.message);}finally{b.setDisabled(false);}}));
  }
}
