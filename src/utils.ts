const levelData: { [key: number]: [string, number, number] } = {
  101: ['初心一', 20, 0],
  102: ['初心二', 80, 0],
  103: ['初心三', 200, 0],
  201: ['雀士一', 600, 300],
  202: ['雀士二', 800, 400],
  203: ['雀士三', 1000, 500],
  301: ['雀杰一', 1200, 600],
  302: ['雀杰二', 1400, 700],
  303: ['雀杰三', 2000, 1000],
  401: ['雀豪一', 2800, 1400],
  402: ['雀豪二', 3200, 1600],
  403: ['雀豪三', 3600, 1800],
  501: ['雀圣一', 4000, 2000],
  502: ['雀圣二', 6000, 3000],
  503: ['雀圣三', 9000, 4500],
  601: ['魂天', 999999, 10000],
  // For downgraded 701
  603: ['雀圣三', 9000, 4500],
}

export function judgeLevel(level: number): string {
  if (Math.floor(level / 100) % 100 === 7) return `魂天${level % 100}`
  return levelData[level % 1000][0]
}

export function levelMax(level: number): number {
  if (Math.floor(level / 100) % 100 === 7) return 2000
  return levelData[level % 1000][1]
}

export function levelStart(level: number): number {
  if (Math.floor(level / 100) % 100 === 7) return 1000
  return levelData[level % 1000][2]
}

export function judgeRoom(room_level: number): string {
  if (room_level === 0) return '总体'
  else if (room_level === 1) return '金之间'
  else if (room_level === 2) return '玉之间'
  else if (room_level === 3) return '王座之间'
  else throw RangeError(`${room_level} is not valid room level`)
}
