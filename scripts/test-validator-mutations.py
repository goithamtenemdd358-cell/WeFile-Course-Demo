#!/usr/bin/env python3
"""Negative tests of the blueprint validator. Never mutate the actual package."""
from pathlib import Path
from tempfile import TemporaryDirectory
import shutil,json,subprocess,sys
ROOT=Path(__file__).resolve().parents[1]
def save(p,x):p.write_text(json.dumps(x,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def run():
 results=[]
 for case in ['remove_page12_buttons','undefined_response_schema','mutate_source_transcript','bad_button_target']:
  with TemporaryDirectory(prefix='wefile-spec-probe-') as td:
   root=Path(td)/'copy';shutil.copytree(ROOT,root,ignore=shutil.ignore_patterns('node_modules','.git','artifacts','backups','__pycache__'))
   if case=='remove_page12_buttons':
    p=root/'spec/pages.json';x=json.loads(p.read_text(encoding='utf-8'));next(q for q in x if q['pageId']=='12')['buttons']=next(q for q in x if q['pageId']=='12')['buttons'][:1];save(p,x)
   elif case=='undefined_response_schema':
    p=root/'spec/api-contract.json';x=json.loads(p.read_text(encoding='utf-8'));x[0]['responseSchema']='#/$defs/NeverDefinedDTO';save(p,x)
   elif case=='mutate_source_transcript':
    p=root/'sources/PRD_SOURCE.md';p.write_text(p.read_text(encoding='utf-8').replace('组员不可查看他人任务的修改意见','组员可以查看他人任务的修改意见'),encoding='utf-8')
   else:
    p=root/'spec/pages.json';x=json.loads(p.read_text(encoding='utf-8'));x[0]['buttons'][0]['targetPageIds']=['99'];save(p,x)
   # Sync generated prose, so failure must not rely only on stale generated Markdown.
   subprocess.run([sys.executable,'-X','utf8',str(root/'scripts/render-spec-docs.py')],check=True,capture_output=True,text=True,encoding='utf-8')
   cp=subprocess.run([sys.executable,'-X','utf8',str(root/'scripts/validate-blueprint.py')],capture_output=True,text=True,encoding='utf-8')
   report=json.loads(cp.stdout)
   results.append({'case':case,'exitCode':cp.returncode,'status':report['status'],'errors':report['errors'],'expected':'FAIL'})
 output={'scope':'BLUEPRINT_VALIDATOR_NEGATIVE_TESTS_NOT_APPLICATION_TESTS','status':'PASS' if all(r['status']=='FAIL' and r['exitCode']!=0 for r in results) else 'FAIL','cases':results}
 (ROOT/'docs/VALIDATOR_MUTATIONS.json').write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 print(json.dumps(output,ensure_ascii=False,indent=2));return output
if __name__=='__main__':sys.exit(0 if run()['status']=='PASS' else 1)
