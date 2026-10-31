import {Modal,Notice,Setting,TFolder,setIcon,type App} from 'obsidian';
import {folderTree,folderTreeMatches} from './folder-rules-tree.mjs';
import {localizeMessage} from './localized-obsidian';

// Presentation only: the caller revalidates the selection before sharing/mounting.
export function chooseSharedFolder(app:App, options:{title:string;description:string;action:string;unavailable:(path:string)=>string;select:(path:string)=>Promise<unknown>}) {
    class Picker extends Modal {
        override onOpen() {
            this.modalEl.addClass('arcalink-shared-folder-picker');
            this.titleEl.setText(localizeMessage(options.title));
            this.contentEl.createEl('p',{text:localizeMessage(options.description)});
            const paths=app.vault.getAllLoadedFiles().filter(f=>f instanceof TFolder&&f.path&&f.path!=='/').map(f=>f.path);
            const tree=folderTree(paths),expanded=new Set<string>();
            let query='',selected='',busy=false,submit:any,search:any;
            const rows:any[]=[];
            const searchRow=new Setting(this.contentEl).setName('Поиск папок');
            const list=this.contentEl.createDiv({cls:'arcalink-shared-folder-tree',attr:{'aria-label':localizeMessage('Папки')}});
            const empty=this.contentEl.createEl('p',{text:localizeMessage('Папки не найдены.')});
            const selection=this.contentEl.createEl('p');
            const update=()=>{
                const matches=folderTreeMatches(tree.nodes,query);
                empty.hidden=matches.visible.size>0;
                for(const {node,item,group,branch,radio,reason} of rows){
                    item.hidden=!matches.visible.has(node.path);
                    const open=query.trim()?matches.opened.has(node.path):expanded.has(node.path);
                    if(group){group.hidden=!open;branch.setAttribute('aria-expanded',String(open));branch.disabled=busy||!!query.trim();}
                    radio.checked=selected===node.path;radio.disabled=busy||!!reason;
                }
                selection.empty();selection.createSpan({text:localizeMessage('Выбранная папка')+': '});
                selection.createSpan({text:selected||localizeMessage('Не выбрана'),attr:{'data-arcalink-user-content':''}});
                submit?.setDisabled(busy||!selected);
            };
            const render=(nodes:any[],parent:HTMLElement)=>{
                for(const node of nodes){
                    const item=parent.createEl('li');
                    const line=item.createDiv({cls:'arcalink-shared-folder-tree-row'});
                    const branch=line.createEl('button',{attr:{type:'button','aria-label':localizeMessage('Развернуть папку')+': '+node.path,'data-arcalink-user-content':''}});
                    setIcon(branch,'chevron-right');
                    const label=line.createEl('label');
                    const radio=label.createEl('input',{type:'radio',attr:{name:'arcalink-shared-folder-selection','aria-label':node.path,'data-arcalink-user-content':'','data-folder-path':node.path}});
                    const icon=label.createSpan({attr:{'aria-hidden':'true'}});setIcon(icon,'folder');
                    label.createSpan({text:node.name,attr:{title:node.path,'data-arcalink-user-content':''}});
                    const reason=options.unavailable(node.path);
                    if(reason)line.createSpan({text:localizeMessage(reason),cls:'arcalink-shared-folder-unavailable'});
                    const group=node.children.length?item.createEl('ul'):null;
                    if(group){branch.addEventListener('click',()=>{if(expanded.has(node.path))expanded.delete(node.path);else expanded.add(node.path);update();});render(node.children,group);}
                    else {branch.disabled=true;branch.tabIndex=-1;branch.setAttribute('aria-hidden','true');branch.addClass('is-leaf');}
                    radio.addEventListener('change',()=>{selected=node.path;update();});
                    rows.push({node,item,group,branch,radio,reason});
                }
            };
            render(tree.roots,list.createEl('ul'));
            searchRow.addText(t=>{search=t;t.setPlaceholder(localizeMessage('Часть пути папки')).onChange(value=>{query=value;update();});});
            new Setting(this.contentEl).addButton(b=>b.setButtonText('Отмена').onClick(()=>this.close())).addButton(b=>{
                submit=b;b.setButtonText(options.action).setCta().onClick(async()=>{
                    if(busy||!selected)return;
                    busy=true;search.setDisabled(true);update();
                    try {const reason=options.unavailable(selected);if(reason)throw Error(localizeMessage(reason));await options.select(selected);this.close();}
                    catch(e:any){new Notice(e.message);}
                    finally {busy=false;search.setDisabled(false);update();}
                });
            });
            update();
        }
    }
    const picker=new Picker(app);
    try { picker.open(); }
    catch(e:any) { picker.close(); new Notice(e.message||localizeMessage('Не удалось открыть выбор папки.')); }
}
