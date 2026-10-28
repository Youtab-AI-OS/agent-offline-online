'use strict'

var assert = require('node:assert/strict')
var merge = require('./index.js')

var source = JSON.parse('{"__proto__":{"polluted":true},"safe":true}')
var result = merge(Object.create(null), source)

assert.equal(result.safe, true)
assert.equal(Object.prototype.hasOwnProperty.call(result, '__proto__'), false)
assert.equal(result.polluted, undefined)
assert.equal(Object.prototype.polluted, undefined)

var normal = merge({ nested: { left: true } }, { nested: { right: true } })
assert.deepEqual(normal, { nested: { left: true, right: true } })
