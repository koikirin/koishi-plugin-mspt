import { } from '@hieuzest/koishi-plugin-mahjong'
import { Context, Dict, Quester, Schema } from 'koishi'
import * as OB from './ob'
import { judgeLevel, levelMax, levelStart } from './utils'

export class Mspt {
  static using = ['mahjong']

  http: Quester

  constructor(private ctx: Context, private config: Mspt.Config) {
    this.http = ctx.http.extend({})
    ctx.command('mspt <pattern>')
      .option('sapk', '-f')
      .action(async ({ options }, pattern) => {
        if (!pattern) return
        let ret: Dict<Mspt.Result> = null
        if (pattern[0] === '$') ret = await this.processQuery({}, parseInt(pattern.slice(1)), null)
        else ret = await this.processQuery({}, null, pattern, options.sapk)

        if (ret) return Object.values(ret).map(this.generateReply.bind(this)).join('\n')
        else return '查询失败'
      })

    ctx.command('mspt2 <pattern:string>')
      .option('sapk', '-f')
      .action(async ({ options }, pattern) => {
        if (!pattern) return
        let account_id
        if (pattern[0] === '$') account_id = parseInt(pattern.slice(1))
        else {
          const res = await ctx.mahjong.ms.execute('fetchAccountInfo', {
            pattern: pattern.slice(2),
            search_next: false
          })
          account_id = res.decode_id
        }
        const res = (await ctx.mahjong.ms.execute('fetchAccountInfo', {
          account_id
        })).account
        if (!res) return '查询失败'

        let result: Mspt.Result = {
          account_id: res.account_id,
          nickname: res.nickname,
          m4: Mspt.generateDescription(res, 'level'),
          m3: Mspt.generateDescription(res, 'level3'),
          src: 'Server'
        }

        return this.generateReply(result)
      })
  }

  async queryAidFromSapk(res: Dict<Mspt.Result>, nickname: string) {
    const quotename = encodeURIComponent(nickname)
    try {
      console.log(`${this.config.sapkUri}/search_player/${quotename}`)
      const data = await this.http.get(`${this.config.sapkUri}/search_player/${quotename}`, {
        params: { limit: 9 }
      })
      for (const d of data || []) {
        if (d.nickname.trim() === nickname) {
          res[d.id] = res[d.id] || {
            account_id: d.id,
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
        params: { limit: 9 }
      })
      for (const d of data || []) {
        if (d.nickname.trim() === nickname) {
          res[d.id] = res[d.id] || {
            account_id: d.id,
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
      this.ctx.mahjong.ms.setAccountMap(v.account_id, v.nickname)
    })
    return Object.values(res).map(v => v.account_id)
  }

  async queryRankFromSapk(res: Dict<Mspt.Result>, accountId: number, forceUpdate: boolean = false) {
    if (accountId in res && !forceUpdate) return true
    try {
      const d = await this.http.get(`${this.config.sapkUri}/player_stats/${accountId}/1262304000000/${Date.now()}`, {
        params: { mode: '16.12.9.15.11.8' }
      })
      if (d && !('error' in d)) {
        res[d.id] = res[d.id] || {
          account_id: d.id,
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
        params: { mode: '26.24.22.25.23.21' }
      })
      if (d && !('error' in d)) {
        res[d.id] = res[d.id] || {
          account_id: d.id,
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
    return this.ctx.mahjong.ms.queryAccountIdFromNickname(nickname)
  }

  async queryRankFromOb(res: Dict<Mspt.Result>, accoundId: number) {
    const result = await OB.queryFromObById(this.ctx, accoundId)
    if (result) res[accoundId] = result
    return !!result
  }

  async processQuery(res: Dict<Mspt.Result>, accoundId?: number, nickname?: string, forceSapk: boolean = false) {
    if (accoundId) {
      if (! await this.queryRankFromOb(res, accoundId)) {
        this.ctx.logger('mspt').debug(`mspt $${accoundId}: OB Failed, rollback to sapk`)
        await this.queryRankFromSapk(res, accoundId)
      }
      return res
    } else if (nickname) {
      let aids = await this.queryAidFromOb(res, nickname)
      this.ctx.logger('mspt').info(`mspt ${nickname}: Query aids from OB: ${aids}`)
      if (forceSapk || !aids.length) {
        aids = [...new Set([...aids, ...await this.queryAidFromSapk(res, nickname)])]
        this.ctx.logger('mspt').info(`mspt ${nickname}: Query aids from sapk: ${aids}`)
      }
      for (const aid of aids) await this.processQuery(res, aid)
      return res
    }
  }

  generateReply(res: Mspt.Result) {
    let msg = `${res.nickname} (${this.ctx.mahjong.ms.getAccountZone(res.account_id)}${res.account_id}) `
    msg += `${res.m4||"[]"} ${res.m3||"[]"}`
    if (res.hm3 || res.hm4)
      msg += `\n最高段位 ${res.hm4||"[]"} ${res.hm3||"[]"}`
    msg += `\n*来源: ${res.src}`
    return msg
  }
}

export namespace Mspt {
  export interface Result {
    account_id: number
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
    } if (!iscl && score >= levelMax(level)) {
      if (level % 10 === 3) level += 98
      else level += 1
      score = levelStart(level)
    }
    let msg = `[${judgeLevel(level)} `
    if (judgeLevel(level) === '魂天')
      msg += `${score}]`
    else if (judgeLevel(level).slice(0, 2) === '魂天')
      msg += `${score / 100}]`
    else
      msg += `${score}/${levelMax(level)}]`
    return msg
  }

  export interface Config {
    sapkUri: string
    sapkTriUri: string
  }

  export const Config: Schema<Config> = Schema.object({
    sapkUri: Schema.string().default('https://5-data.amae-koromo.com/api/v2/pl4'),
    sapkTriUri: Schema.string().default('https://5-data.amae-koromo.com/api/v2/pl3')
  })
  
}

export default Mspt