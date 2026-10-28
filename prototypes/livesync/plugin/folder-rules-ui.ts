import {Modal,Notice,Setting,TFolder,setIcon,type App} from 'obsidian';
import {excludedFolders,folderContains,withExcludedFolders} from './folder-exclusions.mjs';
import {folderTree,folderTreeMatches,folderRuleState,setFolderIncluded} from './folder-rules-tree.mjs';
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
    this.modalEl.addClass('arcalink-folder-rules-modal');
    this.contentEl.addClass('arcalink-folder-rules');
    this.contentEl.createEl('p',{text:localizeMessage('Обе галочки включены — папка синхронизируется. Снимите зелёную, чтобы исключить папку на этом устройстве. Снимите красную, чтобы удалить облачную копию и исключить папку на всех устройствах. Локальные файлы сохраняются.')});
    this.contentEl.createEl('p',{text:localizeMessage('Общие папки и совместные заметки управляются отдельно. Удаление облачной копии личной папки не удаляет исходные сообщения и файлы в Telegram.')});
    if(!controller.available)this.contentEl.createEl('p',{text:localizeMessage('Общие исключения сейчас недоступны. Можно изменить локальные исключения.')});
    const available=this.app.vault.getAllLoadedFiles().filter((f:any)=>f instanceof TFolder&&f.path&&f.path!=='/').map((f:any)=>f.path);
    const paths=[...new Set<string>([...available,...local,...common])];
    const tree=folderTree(paths),expanded=new Set<string>();
    let query='';const rows:any[]=[];let search:any,save:any,cancel:any;
    const list=this.contentEl.createDiv({cls:'arcalink-folder-tree'});
    const header=list.createDiv({cls:'arcalink-folder-tree-header'});
    header.createSpan({text:localizeMessage('Папка')});
    header.createSpan({text:localizeMessage('Локально'),cls:'arcalink-folder-local-heading'});
    header.createSpan({text:localizeMessage('Облако'),cls:'arcalink-folder-cloud-heading'});
    const rootList=list.createEl('ul',{cls:'arcalink-folder-tree-list',attr:{'aria-label':localizeMessage('Папки')}});
    const empty=list.createEl('p',{text:localizeMessage('Папки не найдены.')});
    const update=()=>{
      const matches=folderTreeMatches(tree.nodes,query);empty.hidden=!!matches.visible.size;
      for(const {path,item,group,branch,localControl,cloudControl,description} of rows){
        const state=folderRuleState(path,local,common,folderContains,caseSensitive,globalCase);
        item.hidden=!matches.visible.has(path);
        const open=query.trim()?matches.opened.has(path):expanded.has(path);
        if(group){group.hidden=!open;branch.setAttribute('aria-expanded',String(open));branch.setAttribute('aria-label',localizeMessage(open?'Свернуть папку':'Развернуть папку')+': '+path);branch.disabled=this.busy||!!query.trim();}
        localControl.checked=state.local;cloudControl.checked=state.cloud;
        localControl.disabled=this.busy||!!state.localParent||!state.cloud;
        cloudControl.disabled=this.busy||!!state.commonParent||!controller.available;
        const hint=state.commonParent||state.localParent?'Унаследовано от родительской папки. Измените правило выше.':!state.cloud?'Папка исключена на всех устройствах. Локальная настройка сохранена.':!available.includes(path)?'Папка отсутствует на этом устройстве; исключение сохранено.':'';
        description.setText(hint?localizeMessage(hint):'');description.hidden=!hint;
      }
    };
    new Setting(this.contentEl).setName('Поиск папок').addText(text=>{search=text;text.setPlaceholder(localizeMessage('Часть пути папки')).onChange(value=>{query=value.toLocaleLowerCase();update();});});
    this.contentEl.appendChild(list);
    const render=(nodes:any[],container:HTMLElement,depth:number)=>{
      for(const node of nodes){
        const path=node.path,item=container.createEl('li'),row=item.createDiv({cls:'arcalink-folder-tree-row'});
        row.style.setProperty('--arcalink-folder-depth',String(depth));
        const name=row.createDiv({cls:'arcalink-folder-tree-name'});
        const branch=name.createEl('button',{cls:'arcalink-folder-tree-branch',attr:{type:'button','data-arcalink-user-content':''}});
        setIcon(branch,'chevron-right');
        if(!node.children.length){branch.disabled=true;branch.tabIndex=-1;branch.addClass('is-leaf');branch.setAttribute('aria-hidden','true');}
        const icon=name.createSpan({cls:'arcalink-folder-tree-icon',attr:{'aria-hidden':'true'}});setIcon(icon,'folder');
        name.createSpan({text:node.name,cls:'arcalink-folder-tree-label',attr:{title:path,'data-arcalink-user-content':''}});
        const checkbox=(scope:string,label:string)=>{
          const cell=row.createEl('label',{cls:'arcalink-folder-check-cell'});
          return cell.createEl('input',{type:'checkbox',cls:'arcalink-folder-check arcalink-folder-check-'+scope,attr:{'aria-label':localizeMessage(label)+': '+path,title:localizeMessage(label),'data-arcalink-user-content':'','data-folder-path':path,'data-folder-scope':scope}});
        };
        const localControl=checkbox('local','Синхронизировать на этом устройстве'),cloudControl=checkbox('cloud','Хранить в облаке');
        localControl.addEventListener('change',()=>{setFolderIncluded(local,path,localControl.checked,folderContains,caseSensitive);update();});
        cloudControl.addEventListener('change',()=>{setFolderIncluded(common,path,cloudControl.checked,folderContains,globalCase);update();});
        const description=row.createDiv({cls:'arcalink-folder-tree-description'});
        const group=node.children.length?item.createEl('ul',{cls:'arcalink-folder-tree-list'}):null;
        if(group){branch.addEventListener('click',()=>{if(expanded.has(path))expanded.delete(path);else expanded.add(path);update();});render(node.children,group,depth+1);}
        rows.push({path,item,group,branch,localControl,cloudControl,description});
      }
    };
    render(tree.roots,rootList,0);
    if(!paths.length)empty.setText(localizeMessage('В хранилище пока нет папок.'));
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
    if(controller.remotePhase==='preview'||controller.operation&&!controller.operation.confirmed)row.addButton(b=>b.setButtonText('Отменить расчёт').onClick(async()=>{b.setDisabled(true);try{await controller.cancelPreview(true);refresh();}catch(e:any){new Notice(e.message);}finally{b.setDisabled(false);}}));
  }
}
