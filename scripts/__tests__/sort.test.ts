import { sortedObjectByKeys } from '../sort'

describe('sortedObjectByKeys', () => {
  test('should sort keys of a flat object alphabetically', () => {
    const obj = { b: 2, a: 1, c: 3 }
    const sortedObj = { a: 1, b: 2, c: 3 }
    expect(sortedObjectByKeys(obj)).toEqual(sortedObj)
  })

  test('should recursively sort nested objects', () => {
    const obj = {
      c: { z: 3, y: 2, x: 1 },
      a: 1,
      b: { f: 6, d: 4, e: 5 }
    }
    const sortedObj = {
      a: 1,
      b: { d: 4, e: 5, f: 6 },
      c: { x: 1, y: 2, z: 3 }
    }
    expect(sortedObjectByKeys(obj)).toEqual(sortedObj)
  })

  test('should leave array and null leaves untouched while sorting keys', () => {
    const obj = { b: [2, 1], a: [1, 2], d: null, c: 1 }
    const sortedObj = { a: [1, 2], b: [2, 1], c: 1, d: null }
    expect(sortedObjectByKeys(obj)).toEqual(sortedObj)
  })

  test('should not modify the original object', () => {
    const obj = { b: 2, a: 1 }
    sortedObjectByKeys(obj)
    expect(obj).toEqual({ b: 2, a: 1 })
  })
})
