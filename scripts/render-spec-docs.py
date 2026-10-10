#!/usr/bin/env python3
"""Render blueprint specs from JSON. Does not generate or test application source."""
from pathlib import Path
import json
ROOT=Path(__file__).resolve().parents[1]
def load(rel):return json.loads((ROOT/rel).read_text(encoding='utf-8'))
def cell(x):return str(x).replace('|','\\|').replace('\n','<br>')
def table(headers,rows):
 return '\n'.join(['| '+' | '.join(headers)+' |','| '+' | '.join(['---']*len(headers))+' |']+['| '+' | '.join(cell(v) for v in r)+' |' for r in rows])+'\n'
def build_documents():
 pages=load('spec/pages.json');apis=load('spec/api-contract.json');reqs=load('spec/requirements.json');tests=load('spec/acceptance.json');ds=load('spec/engineering-decisions.json');schema=load('spec/contracts.schema.json')
 out={}
 s='# 页面规格与原文逐项对应\n\n由spec/pages.json生成；原始Word最高优先。原文104条编号交互保持逐条映射，另有7条来自显示字段/编辑模式的明确推导。22页保留独立路由。以下映射是待实现规格，不是运行证据。\n\n'
 s+=table(['编号','页面','路由','角色','职责'],[(p['pageId'],p['name'],p['route'],p['access'],p['description']) for p in pages])
 for p in pages:
  s+='\n## '+p['pageId']+' '+p['name']+'\n\n'
  s+='### 原文布局、展示及边界\n\n'
  s+='\n\n'.join(p['entryRequirements']+p['layoutRequirements'])+'\n\n'
  for x in p['displayRequirements']+p['boundaryRequirements']:s+=f"{x['text']}〔{x['sourceId']}〕\n\n"
  s+='### 每项交互\n\n'+table(['ID','原文交互/依据','目标','调用','处理和权限','验收'],[(b['id'],b['sourceText']+'〔'+b['sourceId']+'；'+b['basis']+'〕',b['targetKind']+':'+','.join(b['targetPageIds']),', '.join(b['apiActions']) or '本地交互/导航',b['handler']+'：'+b['behavior'],b['acceptanceId']) for b in p['buttons']])
  s+='\n左上返回策略：'+json.dumps(p['backPolicy'],ensure_ascii=False)+'。普通来源、12实例回溯及固定目的地优先级见NAVIGATION。\n'
 s+='\n## 共用实现约束\n\n每页有加载、空态、失败重试、无权限状态；22页共用global-nav，只有消息/首页铃铛有未读红点。03不放任务或项目列表，18不放任务卡片。页面路由与后端capabilities分别控制导航和权限。\n\n10筛选：全部/待完成/待审核/需修改/已完成/已逾期；11无全部；15：全部/未提交/待审核/需修改/已完成/已逾期；16：待审核/已通过/已退回；18：全部/任务通知/修改意见/审核结果；02-A：待提交/待修改。进行中归属按已选定E22。\n'
 out['docs/UI_SPEC.md']=s
 s='# API契约 v0.3.2\n\n由spec/api-contract.json与spec/contracts.schema.json生成。产品原文不规定数据库/API；这些是明确的工程实现选择。所有请求通过api显式action路由。reminders不是客户端业务接口。\n\n'
 s+='''## 统一信封与校验\n\n```json
{"action":"submission.submit","requestId":"one-operation-id","payload":{"taskId":"t1","revisionId":"r2","mode":"OVERWRITE","baseVersionId":"v1","expectedVersionRevision":1,"expectedTaskRevision":3}}
```

成功`{ok:true,data,requestId,serverNow}`；失败`{ok:false,error:{code,message,retryable,field?},requestId,serverNow}`。请求ID不是身份，所有时间为毫秒时间戳；响应schema约束data字段。业务变更要幂等requestId，auth.bootstrap按可信身份确定性建用户例外；lookup频控计数不可因重放跳过。未知字段拒绝，不允许客户端role/openid提升权限。

字段唯一规格在JSON Schema `$defs`：每个action分别有req_*与res_*；JSON不仅包一段字符串。对象均列必填/可选与额外字段规则，枚举、nullable和分支条件明确。关系授权/当前任务状态/CAS须业务校验，结构schema不能证明这些行为。

13/20提交成功必须原文toast2–3秒回12；失败原文toast“提交失败，请检查网络或文件大小”并留本页，错误区显示真实原因。12直接提交只刷新本页。读票据使用业务ID，绝不接任意URL/blobId。Project.update从已保存EDIT草稿发布，不接受ownerId/status/邀请码/角色修改。

'''
 s+=table(['action','请求','响应data定义','权限','副作用/幂等','业务约束'],[(a['action'],a['payload']+'；'+a['requestSchema'],a['responseSchema'],a['authorization'],a['sideEffects']+'；'+a['idempotencyPolicy'],a['rules']) for a in apis])
 s+='\n## 数据类型字段目录\n\n下表只作索引；完整类型、长度、分支与必填规则以schema为准。不得直接把数据库文档传给前端。\n\n'
 rows=[]
 for name,d in schema['$defs'].items():
  if name.startswith(('req_','res_')):continue
  if d.get('type')=='object':rows.append((name,', '.join(d.get('properties',{})),', '.join(d.get('required',[]))))
  else:rows.append((name,json.dumps(d,ensure_ascii=False),''))
 s+=table(['类型','字段/规则','必填字段'],rows)
 s+='''
## 资源/状态与接口边界

read target kind含reference（referenceId）、version（visibleVersionId）、submission（submissionId）、taskDraft（taskId）、projectDraft（draftId+revisionId）、avatar（本人的avatar revisionId）、cover（projectId）。读取规则先解析资源真实归属，再校验当前角色/轮次和lifecycle。普通用户对AUDIT_ONLY一律不给票据；不存在与无权敏感资源统一NOT_ACCESSIBLE。avatar/cover不能代理读取其他用途。

FIRST只在本轮无正式提交、TODO/DOING；KEEP/OVERWRITE只在需修改且当前基线匹配；两种修改模式都要求baseVersionId和expectedVersionRevision。草稿完整保存mode/base；12恢复提交不丢选择。revision只能是本人本轮TASK_DRAFT封存资源或已保存交稿草稿；不可拿参考、旧轮次、已提交或审计资源冒充新上传。

project.draftOpen先分配服务器上下文；NEW/EDIT隔离。publish仅NEW，update仅EDIT，失败不改变公开数据。详细生命周期见DRAFTS_AND_ASSETS。

review.reject.revisionDueAt为null表示沿用当前任务DDL；有值更新持久化dueAt/dueRevision，FeedbackDTO同时返回实际effectiveDueAt及本次newDueAt；旧提交快照保持。important程度枚举是E20默认而非原文列定。

notification.read仅二选一传notificationId/reviewId，不传recipientId。notification.readAll使用收件人签发序号快照；游标和水位不能决定权限。noticeSeq规则、容量事务、重试见CONSISTENCY。member.list也显式分页，负责人选择器加载全部已加入组员后筛选，不以默认第一页作为完整成员列表。

定时器入口按实际平台调用权限及可信上下文保护，不能凭event.type字段授权。首次资料接口不能被profileComplete守卫拦在门外；所有已完成资料的人都可创建新项目，不预先要求组长角色。
'''
 out['docs/API_CONTRACT.md']=s
 out['docs/REQUIREMENTS.md']='# 需求与来源追踪\n\n原始Word最高优先；来源要求与工程默认分开；未定处已由助手按用户本轮授权选定，直接用于Demo施工，不再等待逐项确认。原文逐段条目见source-clauses，页面逐项交互见pages；所有实现状态初始NOT_IMPLEMENTED。\n\n'+table(['ID','来源','要求','页面','接口','验收'],[(r['id'],r['source'],r['requirement'],','.join(r['pages']),','.join(r['apiActions']),','.join(r['acceptanceTests'])) for r in reqs])
 out['docs/ACCEPTANCE_CHECKLIST.md']='# 验收规格 v0.3.2\n\n这是工程推导用例，不是原Word未展开的第6章。NOT_RUN表示没有执行；总条目数不是自动测试覆盖率。原文展示/交互需独立对照source，不只校验本包自写的按钮表。真实设备/云端与本地规格检查分开。\n\n'+table(['ID','需求','层级','场景','步骤','预期','状态'],[(t['id'],','.join(t['requirements']),t['level'],t['scenario'],t['steps'],t['expected'],t['status']) for t in tests])
 out['docs/DECISIONS.md']='# 来源解释与工程默认登记\n\n优先级：用户权威Word高于本表。SELECTED_DEMO_DEFAULT_BY_DELEGATION表示用户已授权助手对未定处选择合理默认，本表即首版执行规则，不需要逐项事前确认；不冒称原文逐字规定或用户逐项指定。原文明示要求不变，后续试用可修订。当前阶段直接开发，不再以这些空白为理由重复规划。\n\n'+table(['ID','主题','当前规则','原文边界','状态','影响'],[(d['id'],d['topic'],d['decision'],d['sourceBoundary'],d['authorityStatus'],d['impact']) for d in ds])
 return out
if __name__=='__main__':
 for rel,content in build_documents().items():(ROOT/rel).write_text(content,encoding='utf-8')
 print('Rendered '+str(len(build_documents()))+' specification documents (not application source).')
