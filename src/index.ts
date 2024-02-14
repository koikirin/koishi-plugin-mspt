import { } from '@hieuzest/koishi-plugin-mahjong'
import { Context, Dict, Quester, Schema } from 'koishi'
import * as OB from './ob'
import { judgeLevel, levelMax, levelStart } from './utils'

declare module 'koishi' {
  interface User {
    'mspt/bind': string
  }
}

export class Mspt {
  static inject = ['mahjong', 'mahjong.majsoul', 'mahjong.database']

  http: Quester

  constructor(private ctx: Context, private config: Mspt.Config) {
    this.http = ctx.http.extend({})

    ctx.model.extend('user', {
      'mspt/bind': 'string',
    })

    ctx.command('mspt [pattern:rawtext]', '查询雀魂PT')
      .option('sapk', '-f')
      .option('server', '-s')
      .option('bind', '-b', { descPath: '绑定至当前用户' })
      .usage('pattern为NICKNAME/$AID/$$EID')
      .userFields(['mspt/bind'])
      .action(async ({ session, options }, pattern) => {
        if (options.bind) session.user['mspt/bind'] = pattern ?? ''
        pattern ||= session.user['mspt/bind']
        if (!pattern) return session.execute('mspt -h', true)
        if (pattern.startsWith('$$')) {
          await session.execute(`mspt2 ${pattern.slice(2)}`)
          return
        }
        let ret: Dict<Mspt.Result> = null
        if (pattern[0] === '$') ret = await this.processQuery({}, parseInt(pattern.slice(1)), null)
        else { ret = await this.processQuery({}, null, pattern, { rankQueryingPreference: options.server ? 'server' : options.sapk ? 'sapk' : undefined }) }
        if (ret && Object.keys(ret).length) return Object.values(ret).map(this.generateReply.bind(this)).join('\n')
        else return '查询失败'
      })

    ctx.command('mspt/mspt2 <pattern:string>', '查询雀魂PT')
      .usage('pattern为EID/$AID')
      .action(async ({ session }, pattern) => {
        if (!pattern) return session.execute('mspt2 -h', true)
        let accountId
        if (pattern[0] === '$') accountId = parseInt(pattern.slice(1))
        else {
          const res = await ctx.mahjong.majsoul.execute('searchAccountByPattern', {
            search_next: false,
            pattern,
          })
          accountId = res.decode_id
        }
        if (!accountId) return '查询失败'

        const res = (await ctx.mahjong.majsoul.execute('fetchAccountInfo', {
          account_id: accountId,
        })).account
        if (!res) return '查询失败'

        const result: Mspt.Result = {
          accountId: res.account_id,
          nickname: res.nickname,
          m4: Mspt.generateDescription(res, 'level'),
          m3: Mspt.generateDescription(res, 'level3'),
          src: 'Server',
        }

        return this.generateReply(result)
      })
  }

  async queryAidFromSapk(res: Dict<Mspt.Result>, nickname: string) {
    const quotename = encodeURIComponent(nickname)
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
          res[d.id].src = '牌谱屋'
        }
      }
    } catch (e) {
      this.ctx.logger('mspt').debug(`Fail to query ${nickname} from sapk`)
    }

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
          res[d.id].src = '牌谱屋'
        }
      }
    } catch (e) {
      this.ctx.logger('mspt').debug(`Fail to query ${nickname} from sapk`)
    }

    // Update account_map
    Object.values(res).forEach((v, _) => {
      this.ctx.mahjong.majsoul.setAccountMap(v.accountId, v.nickname)
    })
    return Object.values(res).map(v => v.accountId)
  }

  async queryRankFromSapk(res: Dict<Mspt.Result>, accountId: number, forceUpdate: boolean = false) {
    if (accountId in res && !forceUpdate) return true
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
        if ('max_level' in d) res[d.id].hm4 = Mspt.generateDescription(d, 'max_level')
        res[d.id].src = '牌谱屋'
      }
    } catch (e) {
      this.ctx.logger('mspt').debug(`Fail to query $${accountId} from sapk`, e)
    }

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
        if ('max_level' in d) res[d.id].hm3 = Mspt.generateDescription(d, 'max_level')
        res[d.id].src = '牌谱屋'
      }
    } catch (e) {
      this.ctx.logger('mspt').debug(`Fail to query $${accountId} from sapk`)
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
        if (!ret) this.ctx.logger('mspt').debug(`query $${accountId}: OB Failed, rollback to server`)
        else return res
      }
      if (rankQueryingPreference === 'database' || rankQueryingPreference === 'server') {
        const ret = (await this.ctx.mahjong.majsoul.execute('fetchAccountInfo', {
          account_id: accountId,
        })).account
        if (!ret) this.ctx.logger('mspt').debug(`query $${accountId}: server Failed, rollback to sapk`)
        else {
          res[accountId] = {
            accountId: ret.account_id,
            nickname: ret.nickname,
            m4: Mspt.generateDescription(ret, 'level'),
            m3: Mspt.generateDescription(ret, 'level3'),
            src: 'Server',
          }
          return res
        }
      }
      await this.queryRankFromSapk(res, accountId)
      return res
    } else if (nickname) {
      let aids = []
      if (aidQueryingPreference === 'database') {
        aids = await this.queryAidFromOb(res, nickname)
        this.ctx.logger('mspt').debug(`query ${nickname}: Query aids from OB: ${aids}`)
      }
      if (!aids.length) {
        aids = [...new Set([...aids, ...await this.queryAidFromSapk(res, nickname)])]
        this.ctx.logger('mspt').debug(`query ${nickname}: Query aids from sapk: ${aids}`)
      }
      for (const aid of aids) await this.processQuery(res, aid, undefined, options)
      return res
    }
  }

  generateReply(res: Mspt.Result) {
    let msg = `${res.nickname} (${this.ctx.mahjong.majsoul.getAccountZone(res.accountId)}${res.accountId}) `
    msg += `${res.m4 || '[]'} ${res.m3 || '[]'}`
    if (res.hm3 || res.hm4) { msg += `\n最高段位 ${res.hm4 || '[]'} ${res.hm3 || '[]'}` }
    msg += `\n*来源: ${res.src}`
    return msg
  }
}

export namespace Mspt {
  export interface Result {
    accountId: number
    nickname: string
    m4?: string
    m3?: string
    hm4?: string
    hm3?: string
    src?: string
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

  type QueryingPreference = 'database' | 'sapk' | 'server'

  export interface Preference {
    aidQueryingPreference?: QueryingPreference
    rankQueryingPreference?: QueryingPreference
  }
  export interface Config extends Preference {
    sapkUri: string
    sapkTriUri: string
  }

  export const Config: Schema<Config> = Schema.object({
    sapkUri: Schema.string().default('https://5-data.amae-koromo.com/api/v2/pl4'),
    sapkTriUri: Schema.string().default('https://5-data.amae-koromo.com/api/v2/pl3'),
    aidQueryingPreference: Schema.union<QueryingPreference>(['database', 'sapk']).default('sapk'),
    rankQueryingPreference: Schema.union<QueryingPreference>(['database', 'sapk', 'server']).default('sapk'),
  })

}

export default Mspt
