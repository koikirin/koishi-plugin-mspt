import { } from '@hieuzest/koishi-plugin-mahjong'
import { } from '@koishijs/plugin-server'
import { Context, Dict, HTTP, Schema, Session } from 'koishi'
import * as OB from './ob'
import { decodeAccountId, getAccountZone, judgeLevel, levelMax, levelStart } from './utils'

declare module 'koishi' {
  interface User {
    'mspt/bind': string
  }
}

export class Mspt {
  static name = 'mspt'

  http: HTTP

  constructor(private ctx: Context, private config: Mspt.Config) {
    this.http = ctx.http.extend({})

    ctx.i18n.define('zh-CN', require('./locales/zh-CN'))

    ctx.model.extend('user', {
      'mspt/bind': 'string',
    })

    ctx.command('mspt [pattern:rawtext]')
      .option('sapk', '-f')
      .option('server', '-s')
      .option('type', '-t <type:string>')
      .option('bind', '-b')
      .usage('pattern: NICKNAME / $AID / $$EID')
      .userFields(['mspt/bind'])
      .action(async ({ session, options }, pattern) => {
        if (options.bind) session.user['mspt/bind'] = pattern ?? ''
        pattern ||= session.user['mspt/bind']
        if (!pattern) return options.bind ? '' : session.execute('help mspt')
        if (pattern.startsWith('$$')) {
          pattern = `$${decodeAccountId(parseInt(pattern.slice(2)))}`
        }
        let ret: Dict<Mspt.Result> = null
        if (pattern[0] === '$') ret = await this.processQuery({}, parseInt(pattern.slice(1)), null)
        else {
          ret = await this.processQuery({}, null, pattern, {
            rankQueryingPreference: options.server ? 'server' : options.sapk ? 'sapk' : undefined,
            matchType: options.type as any,
          })
        }
        if (ret && Object.keys(ret).length) return Object.values(ret).map(r => this.generateReply(session, r)).join('\n')
        else return session.text('.failed')
      })

    ctx.command('mspt/mspt2 <pattern:string>')
      .usage('pattern: EID / $AID')
      .action(async ({ session }, pattern) => {
        if (!pattern) return session.execute('help mspt2')
        let accountId: number
        if (pattern[0] === '$') accountId = parseInt(pattern.slice(1))
        else {
          const res = await ctx.mahjong.majsoul.execute('searchAccountByPattern', {
            search_next: false,
            pattern,
          })
          accountId = res.decode_id
        }
        if (!accountId) return session.text('.failed')

        const res = (await ctx.mahjong.majsoul.execute('fetchAccountInfo', {
          account_id: accountId,
        })).account
        if (!res) return session.text('.failed')

        this.ctx.mahjong.majsoul.setAccountMap(res.account_id, res.nickname)

        const result: Mspt.Result = {
          accountId: res.account_id,
          nickname: res.nickname,
          m4: Mspt.generateDescription(res, 'level'),
          m3: Mspt.generateDescription(res, 'level3'),
          raw4: res['level'],
          raw3: res['level3'],
          src: 'server',
        }

        return this.generateReply(session, result)
      })

    if (this.config.exportApi) {
      ctx.inject(['server'], (ctx) => {
        ctx.server.get(this.config.exportApiEndpoint, async (kCtx) => {
          const { pattern, aid, rank, type } = kCtx.request.query as Dict<string>
          const options: Mspt.Preference = {
            aidQueryingPreference: aid as Mspt.QueryingPreference,
            rankQueryingPreference: rank as Mspt.QueryingPreference,
            matchType: type as any,
          }
          let ret: Dict<Mspt.Result> = null

          if (pattern.startsWith('$$')) {
            const accountId = decodeAccountId(parseInt(pattern.slice(2)))
            ret = await this.processQuery({}, accountId, null, options)
          } else if (pattern.startsWith('$')) {
            const accountId = parseInt(pattern.slice(1))
            ret = await this.processQuery({}, accountId, null, options)
          } else {
            ret = await this.processQuery({}, null, pattern, options)
          }

          kCtx.type = 'json'
          kCtx.body = ret
        })
      })
    }
  }

  async queryAidFromSapk(res: Dict<Mspt.Result>, nickname: string, options: Mspt.Preference) {
    const quotename = encodeURIComponent(nickname)

    if (options.matchType !== '3') {
      try {
        const data = await this.http.get(`${this.config.sapkUri}/search_player/${quotename}`, {
          params: { limit: 9 },
        })
        for (const d of data || []) {
          if (d.nickname.trim() === nickname) {
            res[d.id] = res[d.id] || {
              accountId: d.id,
              nickname: d.nickname,
            }
            res[d.id].m4 = Mspt.generateDescription(d)
            res[d.id].raw4 = d['level']
            res[d.id].src = 'sapk'
          }
        }
      } catch (e) {
        this.ctx.logger.debug(`Fail to query ${nickname} from sapk`)
      }
    }

    if (options.matchType !== '4') {
      try {
        const data = await this.http.get(`${this.config.sapkTriUri}/search_player/${quotename}`, {
          params: { limit: 9 },
        })
        for (const d of data || []) {
          if (d.nickname.trim() === nickname) {
            res[d.id] = res[d.id] || {
              accountId: d.id,
              nickname: d.nickname,
            }
            res[d.id].m3 = Mspt.generateDescription(d)
            res[d.id].raw3 = d['level']
            res[d.id].src = 'sapk'
          }
        }
      } catch (e) {
        this.ctx.logger.debug(`Fail to query ${nickname} from sapk`)
      }
    }

    // Update account_map
    if (this.ctx.mahjong?.majsoul) {
      Object.values(res).forEach((v, _) => {
        this.ctx.mahjong.majsoul.setAccountMap(v.accountId, v.nickname)
      })
    }
    return Object.values(res).map(v => v.accountId)
  }

  async queryRankFromSapk(res: Dict<Mspt.Result>, accountId: number, forceUpdate: boolean, options: Mspt.Preference) {
    if (accountId in res && !forceUpdate) return true

    if (options.matchType !== '3') {
      try {
        const d = await this.http.get(`${this.config.sapkUri}/player_stats/${accountId}/1262304000000/${Date.now()}`, {
          params: { mode: '16.12.9.15.11.8' },
        })
        if (d && !('error' in d)) {
          res[d.id] = res[d.id] || {
            accountId: d.id,
            nickname: d.nickname,
          }
          res[d.id].m4 = Mspt.generateDescription(d)
          res[d.id].raw4 = d['level']
          if ('max_level' in d) res[d.id].hm4 = Mspt.generateDescription(d, 'max_level')
          res[d.id].src = 'sapk'
        }
      } catch (e) {
        this.ctx.logger.debug(`Fail to query $${accountId} from sapk`, e)
      }
    }

    if (options.matchType !== '4') {
      try {
        const d = await this.http.get(`${this.config.sapkTriUri}/player_stats/${accountId}/1262304000000/${Date.now()}`, {
          params: { mode: '26.24.22.25.23.21' },
        })
        if (d && !('error' in d)) {
          res[d.id] = res[d.id] || {
            accountId: d.id,
            nickname: d.nickname,
          }
          res[d.id].m3 = Mspt.generateDescription(d)
          res[d.id].raw3 = d['level']
          if ('max_level' in d) res[d.id].hm3 = Mspt.generateDescription(d, 'max_level')
          res[d.id].src = 'sapk'
        }
      } catch (e) {
        this.ctx.logger.debug(`Fail to query $${accountId} from sapk`)
      }
    }

    return true
  }

  async queryAidFromOb(res: Dict<Mspt.Result>, nickname: string) {
    return this.ctx.mahjong.majsoul.queryAccountIdFromNickname(nickname)
  }

  async queryRankFromOb(res: Dict<Mspt.Result>, accountId: number) {
    const result = await OB.queryFromObById(this.ctx, accountId)
    if (result) res[accountId] = result
    return !!result
  }

  async processQuery(res: Dict<Mspt.Result>, accountId?: number, nickname?: string, options: Mspt.Preference = {}) {
    const { rankQueryingPreference = this.config.rankQueryingPreference, aidQueryingPreference = this.config.aidQueryingPreference } = options
    if (accountId) {
      if (rankQueryingPreference === 'database') {
        const ret = await this.queryRankFromOb(res, accountId)
        if (!ret) this.ctx.logger.debug(`query $${accountId}: OB Failed, rollback to server`)
        else return res
      }
      if (rankQueryingPreference === 'database' || rankQueryingPreference === 'server') {
        const ret = (await this.ctx.mahjong.majsoul.execute('fetchAccountInfo', {
          account_id: accountId,
        })).account
        if (!ret) this.ctx.logger.debug(`query $${accountId}: server Failed, rollback to sapk`)
        else {
          res[accountId] = {
            accountId: ret.account_id,
            nickname: ret.nickname,
            m4: Mspt.generateDescription(ret, 'level'),
            m3: Mspt.generateDescription(ret, 'level3'),
            raw4: ret['level'],
            raw3: ret['level3'],
            src: 'server',
          }
          return res
        }
      }
      await this.queryRankFromSapk(res, accountId, false, options)
      return res
    } else if (nickname) {
      let aids = []
      if (aidQueryingPreference === 'database') {
        aids = await this.queryAidFromOb(res, nickname)
        this.ctx.logger.debug(`query ${nickname}: Query aids from OB: ${aids}`)
      }
      if (!aids.length) {
        aids = [...new Set([...aids, ...await this.queryAidFromSapk(res, nickname, options)])]
        this.ctx.logger.debug(`query ${nickname}: Query aids from sapk: ${aids}`)
      }
      for (const aid of aids) await this.processQuery(res, aid, undefined, options)
      return res
    }
  }

  generateReply(session: Session, res: Mspt.Result) {
    let msg = `${res.nickname} (${getAccountZone(res.accountId)}${res.accountId}) `
    msg += `${res.m4 || '[]'} ${res.m3 || '[]'}`
    if (res.hm3 || res.hm4) { msg += `\n${session.text('.highest-level')} ${res.hm4 || '[]'} ${res.hm3 || '[]'}` }
    msg += `\n*${session.text('.referer')}: ${session.text('.referer-' + res.src)}`
    return msg
  }
}

export namespace Mspt {
  export const inject = {
    required: ['database'],
    optional: ['mahjong', 'mahjong.majsoul', 'mahjong.database', 'server'],
  }

  export interface Result {
    accountId: number
    nickname: string
    m4?: string
    m3?: string
    hm4?: string
    hm3?: string
    src?: 'failed' | 'failed-server' | 'server' | 'sapk' | 'sync' | 'subscription' | 'playing'
    raw4?: any
    raw3?: any
  }

  export function generateDescription(data, label: string = 'level') {
    let score = data[label].score + (data[label].delta || 0)
    let level = data[label].id
    const iscl = Math.ceil(level / 100) % 10 === 7
    if (score < 0) {
      if (level % 10 === 1) level -= 98
      else level -= 1
      score = levelStart(level)
    } else if (!iscl && score >= levelMax(level)) {
      if (level % 10 === 3) level += 98
      else level += 1
      score = levelStart(level)
    }
    let msg = `[${judgeLevel(level)} `
    if (judgeLevel(level) === '魂天') {
      msg += `${score}]`
    } else if (judgeLevel(level).slice(0, 2) === '魂天') {
      msg += `${score / 100}]`
    } else {
      msg += `${score}/${levelMax(level)}]`
    }
    return msg
  }

  export type QueryingPreference = 'database' | 'sapk' | 'server'

  export interface Preference {
    aidQueryingPreference?: QueryingPreference
    rankQueryingPreference?: QueryingPreference
    matchType?: '4' | '3'
  }
  export interface Config extends Preference {
    sapkUri: string
    sapkTriUri: string
    exportApi: boolean
    exportApiEndpoint: string
  }

  export const Config: Schema<Config> = Schema.object({
    sapkUri: Schema.string().default('https://5-data.amae-koromo.com/api/v2/pl4'),
    sapkTriUri: Schema.string().default('https://5-data.amae-koromo.com/api/v2/pl3'),
    aidQueryingPreference: Schema.union<QueryingPreference>(['database', 'sapk']).default('sapk'),
    rankQueryingPreference: Schema.union<QueryingPreference>(['database', 'sapk', 'server']).default('sapk'),
    exportApi: Schema.boolean().default(false),
    exportApiEndpoint: Schema.string().default('/mspt'),
  })
}

export default Mspt
