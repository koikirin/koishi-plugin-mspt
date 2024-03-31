import { } from '@hieuzest/koishi-plugin-mahjong'
import { Context, Logger } from 'koishi'
import Mspt from './index'

const logger = new Logger('mspt.ob')

class OBError extends Error {
  message: Mspt.Result['src']

  constructor(message: Mspt.Result['src']) {
    super(message)
  }
}

export async function queryFromObById(ctx: Context, accountId: number): Promise<Mspt.Result> {
  const cursor = ctx.mahjong.database.db('majob').collection('majsoul').find({
    'wg.players.account_id': accountId,
  }).sort('starttime', 'descending').limit(1)
  const doc = await cursor.next()

  if (!doc) return
  const uuid = doc._id as unknown as string
  let dpt, src: Mspt.Result['src']
  try {
    [dpt, src] = await getDptFromPaipu(ctx, uuid, accountId, doc)
  } catch (e) {
    if (e instanceof OBError) {
      [dpt, src] = [0, e.message]
    } else {
      [dpt, src] = [0, 'failed']
      logger.error('Unexpected error', e)
    }
  }

  for (const player of doc.wg.players) {
    if (player.account_id === accountId) {
      return {
        accountId,
        nickname: player.nickname,
        m4: Mspt.generateDescription({
          'level': {
            'delta': doc.wg.players.length === 4 ? dpt : 0,
            ...player.level,
          },
        }),
        m3: Mspt.generateDescription({
          'level': {
            'delta': doc.wg.players.length === 3 ? dpt : 0,
            ...player.level3,
          },
        }),
        src,
        // hm4: '',
        // hm3: '',
      }
    }
  }
}

async function getDptFromPaipu(ctx: Context, uuid: string, accountId: number, doc: any): Promise<[number, Mspt.Result['src']]> {
  const ret = (doc && doc._id === uuid && doc.result) ? doc : null
  if (ret) {
    for (const player of ret.result) { if (player.account_id === accountId) return [player.point, 'subscription'] }
  } else {
    const paipu = await ctx.mahjong.majsoul.getPaipuHead(uuid)
    if (paipu.error) {
      if (paipu.code === 1203) throw new OBError('playing')
      else throw new OBError('failed-server')
    }

    let seat = -1
    for (const p of paipu.head.accounts) {
      if (p.account_id === accountId) {
        seat = p.seat
        break
      }
    }
    for (const p of paipu.head.result.players) {
      if (p.seat === seat) {
        return [p.grading_score, 'sync']
      }
    }
  }
}
