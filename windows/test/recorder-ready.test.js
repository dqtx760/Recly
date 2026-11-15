'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const renderer = fs.readFileSync(path.join(__dirname,'../src/renderer/recorder.js'),'utf8');
function deferred() { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}; }
const state={environment:{ok:true},displays:[{id:1}],selection:{kind:'display',displayId:1},starting:false,session:null,finishing:false,startError:''};
const warmups=[], inputs=[];
const sandbox={state,Promise,Error,render(){},ipcRenderer:{invoke(channel,payload){assert.equal(channel,'recorder:warmup');const gate=deferred();warmups.push({gate,payload});return gate.promise}},prepareInputStreams(){const gate=deferred();inputs.push(gate);return gate.promise}};
vm.runInNewContext(renderer.slice(renderer.indexOf('let readinessSequence ='),renderer.indexOf('function compactWindowHeight()')),sandbox);
(async()=>{
  const first=sandbox.prepareRecordingReadiness();
  assert.equal(state.readiness.ready,false);
  assert.equal(state.readiness.pending,true);
  state.selection={kind:'area',rect:{x:0,y:0,width:640,height:360}};
  const second=sandbox.prepareRecordingReadiness();
  warmups[1].gate.resolve({});inputs[1].resolve({streams:{},problems:[]});
  assert.equal(await second,true);
  warmups[0].gate.reject(Error('过期准备失败'));inputs[0].resolve({streams:{},problems:[]});
  assert.equal(await first,false);
  assert.equal(state.readiness.ready,true,'旧请求失败不能覆盖新配置已就绪状态');
  const failure=sandbox.prepareRecordingReadiness();warmups[2].gate.resolve({});inputs[2].resolve({streams:{},problems:['没有找到麦克风']});
  assert.equal(await failure,false);assert.equal(state.readiness.ready,false);assert.match(state.startError,/没有找到麦克风/);
  state.session={};const count=warmups.length;assert.equal(await sandbox.prepareRecordingReadiness(),false);assert.equal(warmups.length,count,'录制期间不得启动新的预热');

  const picker=deferred();let preparations=0;
  const choosing={state:{environment:{ok:true},selection:{kind:'display'},readiness:{ready:true}},readinessSequence:0,render(){},
    ipcRenderer:{invoke(){return picker.promise}},prepareRecordingReadiness(){preparations++}};
  vm.runInNewContext(renderer.slice(renderer.indexOf('async function chooseSource('),renderer.indexOf('async function deviceMenu(')),choosing);
  const selection=choosing.chooseSource('window');
  assert.equal(choosing.state.readiness.ready,false,'选择器打开时必须撤销就绪，防止快捷键启动旧配置');
  assert.equal(choosing.state.configuring,true);assert.equal(choosing.readinessSequence,1);
  picker.resolve(null);await selection;
  assert.equal(choosing.state.configuring,false);assert.equal(preparations,1,'取消选择也应重新准备原配置');

  const main=fs.readFileSync(path.join(__dirname,'../src/main/main.js'),'utf8');
  let handler;const capture={capture:{kind:'area'},width:640,height:360};const calls=[];const sender={};
  const context={environment:{ok:true},recorderWindow:{isDestroyed:()=>false,webContents:sender},hasRecordingWork:()=>false,
    resolveSource(selection,activate){calls.push(['resolve',selection,activate]);return capture},
    media:{prepareCapture(options){calls.push(['prepare',options]);return Promise.resolve({encoder:'test'})}},
    ipcMain:{handle(channel,callback){assert.equal(channel,'recorder:warmup');handler=callback}}};
  const start=main.indexOf("  ipcMain.handle('recorder:warmup'");
  vm.runInNewContext(main.slice(start,main.indexOf('  // 录制分两步启动',start)),context);
  await handler({sender},{selection:{kind:'display'},frameRate:60});
  assert.equal(calls[0][2],false,'后台预热不得激活/抢占用户选定窗口');
  assert.equal(calls[1][1].fps,60);assert.equal(calls[1][1].source,capture.capture);
  await assert.rejects(handler({sender:{}},{selection:{kind:'display'},frameRate:60}),/无权/);
  console.log('录制提前准备、过期结果隔离及主进程预热接线测试通过。');
})().catch(error=>{console.error(error);process.exitCode=1});
