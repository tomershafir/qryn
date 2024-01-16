require('./wasm_exec')
const { join } = require('path')
const WASM_URL = join(__dirname, 'main.wasm.gz')
const fs = require('fs')
const { gunzipSync } = require('zlib')

class WasmError extends Error {}
module.exports.WasmError = WasmError

const wasmEnt = gunzipSync(fs.readFileSync(WASM_URL))

let counter = 0
const _Go = Go

const makeInstance = async (global) => {
  var go = new _Go()
  const wasm = await WebAssembly.instantiate(wasmEnt, go.importObject)
  go.run(wasm.instance)
  if (global) {
    instance = wasm.instance
  }
  return wasm.instance
}

let instance = makeInstance(true)

const getWasm = async () => {
  if (!instance) {
    const _instance = await makeInstance()
    instance = makeInstance(true)
    return _instance
  }
  if (instance.then) {
    return await makeInstance()
  }
  const _instance = instance
  instance = makeInstance(true)
  return _instance
}

const newId = () => {
  const id = counter
  counter = (counter + 1) & 0xFFFFFFFF
  return id
}

/**
 *
 * @param query {string}
 * @param startMs {number}
 * @param endMs {number}
 * @param stepMs {number}
 * @param getData {function}
 * @returns {Promise<string>}
 */
module.exports.pqlRangeQuery = async (query, startMs, endMs, stepMs, getData) => {
  const _wasm = await getWasm()
  const start = startMs || Date.now() - 300000
  const end = endMs || Date.now()
  const step = stepMs || 15000
  return await pql(query,
    (ctx) => _wasm.exports.pqlRangeQuery(ctx.id, start, end, step),
    (matchers) => getData(matchers, start, end))
}

/**
 *
 * @param query {string}
 * @param timeMs {number}
 * @param getData {function}
 * @returns {Promise<string>}
 */
module.exports.pqlInstantQuery = async (query, timeMs, getData) => {
  const time = timeMs || Date.now()
  const _wasm = await getWasm()
  return await pql(query,
    (ctx) => _wasm.exports.pqlInstantQuery(ctx.id, time),
    (matchers) => getData(matchers, time - 300000, time))
}

module.exports.pqlMatchers = async (query) => {
  const _wasm = await getWasm()
  const id = newId()
  const ctx = new Ctx(id, _wasm)
  ctx.create()
  try {
    ctx.write(query)
    const res1 = _wasm.exports.pqlSeries(id)
    if (res1 !== 0) {
      throw new WasmError(ctx.read())
    }
    /** @type {[[[string]]]} */
    const matchersObj = JSON.parse(ctx.read())
    return matchersObj
  } finally {
    ctx.destroy()
  }
}

/**
 *
 * @param request {{
 *   Request: string,
 *   Ctx: {
 *       IsCluster: boolean,
 *       OrgID: string,
 *       FromS: number,
 *       ToS: number,
 *       TimeSeriesGinTableName: string,
 *       SamplesTableName: string,
 *       TimeSeriesTableName: string,
 *       TimeSeriesDistTableName: string,
 *       Metrics15sTableName: string,
 *       TracesAttrsTable: string,
 *       TracesAttrsDistTable: string,
 *       TracesTable: string,
 *       TracesDistTable: string
 * }}}
 * @returns {Promise<String>}
 * @constructor
 */
module.exports.TranspileTraceQL = async (request) => {
  let _ctx
  try {
    const id = newId()
    const _wasm = await getWasm()
    _ctx = new Ctx(id, _wasm)
    _ctx.create()
    _ctx.write(JSON.stringify(request))
    let res = _wasm.exports.transpileTraceQL(id)
    if (res !== 0) {
      throw new WasmError(_ctx.read())
    }
    res = _ctx.read()
    return res
  } finally {
    _ctx && _ctx.destroy()
  }
}

/**
 *
 * @param query {string}
 * @param wasmCall {function}
 * @param getData {function}
 * @returns {Promise<string>}
 */
const pql = async (query, wasmCall, getData) => {
  const reqId = newId()
  const _wasm = await getWasm()
  const ctx = new Ctx(reqId, _wasm)
  try {
    ctx.create()
    ctx.write(query)
    const res1 = wasmCall(ctx)
    if (res1 !== 0) {
      throw new WasmError(ctx.read())
    }

    const matchersObj = JSON.parse(ctx.read())

    const matchersResults = await Promise.all(
      matchersObj.map(async (matchers, i) => {
        const data = await getData(matchers)
        return { matchers, data }
      }))

    const writer = new Uint8ArrayWriter(new Uint8Array(1024))
    for (const { matchers, data } of matchersResults) {
      writer.writeString(JSON.stringify(matchers))
      writer.writeBytes([data])
    }
    ctx.write(writer.buffer())
    _wasm.exports.onDataLoad(reqId)
    return ctx.read()
  } finally {
    ctx && ctx.destroy()
  }
}

/**
 *
 * @param pprofs
 */
module.exports.pyroscopeSelectMergeStacktraces = async (pprofs) => {
  const reqId = newId()
  const _wasm = await getWasm()
  const ctx = new Ctx(reqId, _wasm)
  ctx.create()
  ctx.write(pprofs)
  const code = _wasm.exports.pyroscopeSelectMergeStacktraces(reqId)
  const res = ctx.read()
  return JSON.parse(res)
}
class Ctx {
  constructor (id, wasm) {
    this.wasm = wasm
    this.id = id
    this.created = false
  }

  create () {
    try {
      this.wasm.exports.createCtx(this.id)
      this.created = true
    } catch (err) {
      throw err
    }
  }

  destroy () {
    try {
      if (this.created) this.wasm.exports.dealloc(this.id)
    } catch (err) {
      throw err
    }
  }

  /**
   *
   * @param data {Uint8Array | string}
   */
  write (data) {
    if (typeof data === 'string') {
      data = (new TextEncoder()).encode(data)
    }
    this.wasm.exports.alloc(this.id, data.length)
    const ptr = this.wasm.exports.alloc(this.id, data.length)
    new Uint8Array(this.wasm.exports.memory.buffer).set(data, ptr)
  }

  /**
   * @returns {String}
   */
  read() {
    const [resPtr, resLen] = [
      this.wasm.exports.getCtxResponse(this.id),
      this.wasm.exports.getCtxResponseLen(this.id)
    ]
    return new TextDecoder().decode(new Uint8Array(this.wasm.exports.memory.buffer).subarray(resPtr, resPtr + resLen))
  }
}

class Uint8ArrayWriter {
  /**
   *
   * @param buf {Uint8Array}
   */
  constructor (buf) {
    this.buf = buf
    this.i = 0
  }

  maybeGrow (len) {
    for (;this.i + len > this.buf.length;) {
      const _buf = new Uint8Array(this.buf.length + 1024 * 1024)
      _buf.set(this.buf)
      this.buf = _buf
    }
  }

  /**
   *
   * @param n {number}
   */
  writeULeb (n) {
    this.maybeGrow(9)
    let _n = n
    if (n === 0) {
      this.buf[this.i] = 0
      this.i++
      return
    }
    while (_n > 0) {
      let part = _n & 0x7f
      _n >>= 7
      if (_n > 0) {
        part |= 0x80
      }
      this.buf[this.i] = part
      this.i++
    }
  }

  /**
   *
   * @param str {string}
   */
  writeString (str) {
    const bStr = (new TextEncoder()).encode(str)
    this.writeULeb(bStr.length)
    this.maybeGrow(b.length)
    this.buf.set(bStr, this.i)
    this.i += bStr.length
    return this
  }

  /**
   *
   * @param buf {Uint8Array[]}
   */
  writeBytes (buf) {
    for (const b of buf) {
      this.writeULeb(b.length)
      this.maybeGrow(b.length)
      this.buf.set(b, this.i)
      this.i += b.length
    }
    return this
  }

  buffer () {
    return this.buf.subarray(0, this.i)
  }
}
