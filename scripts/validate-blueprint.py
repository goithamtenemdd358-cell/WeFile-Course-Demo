#!/usr/bin/env python3
"""Validate source integrity and formal spec consistency; NOT application correctness."""
from pathlib import Path
import hashlib,json,re,sys,importlib.util
from zipfile import ZipFile
import xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parents[1]
def load(x):return json.loads((ROOT/x).read_text(encoding='utf-8'))
def check_spec():
 errors=[];pages=load('spec/pages.json');apis=load('spec/api-contract.json');reqs=load('spec/requirements.json');tests=load('spec/acceptance.json');clauses=load('spec/source-clauses.json');schema=load('spec/contracts.schema.json');meta=load('sources/SOURCE_METADATA.json')
 expected={f'{i:02d}' for i in range(1,21)}|{'02-A','03-A'};pids={p['pageId'] for p in pages};aids={a['action'] for a in apis};rids={r['id'] for r in reqs};tids={t['id'] for t in tests};cids={c['id'] for c in clauses}
 if len(pages)!=22 or pids!=expected or len({p['route'] for p in pages})!=22:errors.append('Page count/IDs/routes differ from source')
 for n,items,ids in [('API',apis,aids),('requirements',reqs,rids),('tests',tests,tids),('source clauses',clauses,cids)]:
  if len(items)!=len(ids):errors.append('Duplicate '+n+' ID')
 raw=ROOT/'sources'/meta['originalFilename'];trans=ROOT/'sources/PRD_SOURCE.md'
 if hashlib.sha256(raw.read_bytes()).hexdigest()!=meta['sha256']:errors.append('Authoritative Word bytes changed')
 if hashlib.sha256(trans.read_bytes()).hexdigest()!=meta['transcriptSha256']:errors.append('Full source transcript bytes changed')
 lines=trans.read_text(encoding='utf-8').splitlines();source_nonempty={i:s for i,s in enumerate(lines,1) if i>=7 and s.strip()}
 if {c['lineStart']:c['text'] for c in clauses}!=source_nonempty:errors.append('Source clause inventory does not match full nonempty transcript')
 # Check each original Word paragraph/cell appears in sequence in transcript, not headings alone.
 ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
 with ZipFile(raw) as z:root=ET.fromstring(z.read('word/document.xml'))
 original=[]
 for p in root.findall('.//w:body/w:p',ns):
  s=''.join(t.text or '' for t in p.findall('.//w:t',ns))
  if s.strip():original.append(s)
 full=trans.read_text(encoding='utf-8');at=0
 for s in original:
  pos=full.find(s,at)
  if pos<0:errors.append('Original paragraph absent/out of order: '+s[:60]);break
  at=pos+len(s)
 for cell in root.findall('.//w:tbl//w:tc',ns):
  s=''.join(t.text or '' for t in cell.findall('.//w:t',ns))
  if s.strip() and s not in full:errors.append('Original table cell absent: '+s[:60])
 mandatory={c['id'] for c in clauses if c['kind']=='action'}
 buttons=[b for p in pages for b in p['buttons']]
 ids={b['id'] for b in buttons}
 if len(buttons)!=len(ids):errors.append('Duplicate interaction ID')
 mapped=[b['sourceId'] for b in buttons if b['basis']=='SOURCE_EXPLICIT']
 if len(mapped)!=104 or len(set(mapped))!=104 or set(mapped)!=mandatory:errors.append('104 original numbered interactions are not exactly mapped')
 byc={c['id']:c for c in clauses}
 for p in pages:
  if not p['globalNavigation']:errors.append('Missing global nav '+p['pageId'])
  if set(p['apiActions'])-aids:errors.append('Undefined API in page '+p['pageId'])
  if set(p['sourceClauses'])!={c['id'] for c in clauses if c['pageId']==p['pageId']}:errors.append('Page source clause omission '+p['pageId'])
  for b in p['buttons']:
   if b['sourceId'] not in byc or b['sourceText']!=byc[b['sourceId']]['text']:errors.append('Interaction source mismatch '+b['id'])
   if set(b['targetPageIds'])-pids or b['targetKind'] not in {'PAGE','STAY','SOURCE','TASK_ANCHOR','CONDITIONAL'}:errors.append('Bad interaction target '+b['id'])
   if b['targetKind']=='PAGE' and len(b['targetPageIds'])!=1:errors.append('PAGE requires one target '+b['id'])
   if b['targetKind']=='TASK_ANCHOR' and b['targetPageIds']!=['12']:errors.append('Task anchor must return12 '+b['id'])
   if set(b['apiActions'])-aids or b['acceptanceId'] not in tids or not b['handler'] or not b['behavior']:errors.append('Incomplete interaction '+b['id'])
 for r in reqs:
  if set(r['pages'])-pids or set(r['apiActions'])-aids or set(r['acceptanceTests'])-tids or not r['acceptanceTests']:errors.append('Bad requirement links '+r['id'])
 for t in tests:
  if not t['requirements'] or set(t['requirements'])-rids:errors.append('Bad test links '+t['id'])
 defs=schema['$defs']
 def walk(x):
  if isinstance(x,dict):
   if '$ref' in x and (not x['$ref'].startswith('#/$defs/') or x['$ref'][8:] not in defs):errors.append('Undefined schema ref '+x['$ref'])
   for v in x.values():walk(v)
  elif isinstance(x,list):
   for v in x:walk(v)
 walk(schema)
 for a in apis:
  for f in ['requestSchema','responseSchema']:
   if a[f][8:] not in defs:errors.append('Unknown API schema '+a['action']+' '+f)
 if not next(a for a in apis if a['action']=='auth.bootstrap')['write']:errors.append('bootstrap user creation misclassified read-only')
 schema_examples=0
 try:
  import jsonschema
  jsonschema.Draft202012Validator.check_schema(schema)
  for e in load('spec/contract-examples.json'):
   spec={**schema,'$ref':'#/$defs/'+e['definition']}
   actual=jsonschema.Draft202012Validator(spec).is_valid(e['value'])
   if actual!=e['valid']:errors.append('Contract example mismatch '+e['id'])
   schema_examples+=1
 except ImportError:errors.append('Install requirements-spec.txt before full validation; schema checks not run')
 except Exception as exc:errors.append('Schema validation error: '+str(exc))
 # Generated prose must match the JSON, rather than two manually maintained versions.
 spec=importlib.util.spec_from_file_location('render_specs',ROOT/'scripts/render-spec-docs.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
 for rel,content in mod.build_documents().items():
  if (ROOT/rel).read_text(encoding='utf-8')!=content:errors.append('Generated prose drift; run renderer: '+rel)
 for f in ROOT.rglob('*.md'):
  s=f.read_text(encoding='utf-8')
  if sum(1 for l in s.splitlines() if l.lstrip().startswith('```'))%2:errors.append('Unbalanced code fence '+str(f.relative_to(ROOT)))
 report={'validationType':'SOURCE_INTEGRITY_AND_FORMAL_SPEC_ONLY','status':'PASS' if not errors else 'FAIL','pages':len(pages),'sourceTextItemsIncludingHeadings':len(clauses),'sourceNumberedInteractions':len(mandatory),'mappedInteractionsIncludingDerived':len(buttons),'apiActions':len(apis),'schemaDefinitions':len(defs),'schemaExamplesChecked':schema_examples,'requirements':len(reqs),'acceptanceSpecifications':len(tests),'semanticCompleteness':'NOT_PROVEN_BY_THIS_SCRIPT','demoDefaults':'SELECTED_BY_ASSISTANT_UNDER_USER_DELEGATION','applicationImplementation':'SEE_IMPLEMENTATION_STATUS','applicationTests':'SEE_LOCAL_TEST_RESULT_NOT_INFERRED_FROM_SPEC','errors':errors}
 return report
if __name__=='__main__':
 report=check_spec();(ROOT/'docs/BLUEPRINT_VALIDATION.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');print(json.dumps(report,ensure_ascii=False,indent=2));sys.exit(0 if report['status']=='PASS' else 1)
