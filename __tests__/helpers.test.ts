import * as core from '@actions/core'
import * as helpers from '../src/helpers'

describe('successful_params_parsing', () => {
  it('empty params', async () => {
    const params = helpers.parse_additional_parameters(``)

    expect(params).toEqual({})
  })

  it('one line params', async () => {
    const params = helpers.parse_additional_parameters(`p=v`)

    expect(params).toEqual({ p: 'v' })
  })

  it('two line params', async () => {
    const params = helpers.parse_additional_parameters(`
    
    p1=v1


    p2=v2
    
    `)

    expect(params).toEqual({ p1: 'v1', p2: 'v2' })
  })

  it('five line params', async () => {
    const params = helpers.parse_additional_parameters(`p=v
    p1 =    v1 
    p2 = v2 
    p3 = v3   
    p4 = v4    
    `)

    expect(params).toEqual({ p: 'v', p1: 'v1', p2: 'v2', p3: 'v3', p4: 'v4' })
  })

  it('leading empty space in params', async () => {
    const params = helpers.parse_additional_parameters(`
    
    
    p   =   v`)

    expect(params).toEqual({ p: 'v' })
  })

  it('trailing empty space in params', async () => {
    const params = helpers.parse_additional_parameters(`p=v
    
    
    
    `)

    expect(params).toEqual({ p: 'v' })
  })

  it('two line params with equal', async () => {
    const params = helpers.parse_additional_parameters(`
    p1='inner_value_1=1'
    p2='v2'`)

    expect(params).toEqual({ p1: "'inner_value_1=1'", p2: "'v2'" })
  })

  it('warns and skips lines without an = sign', async () => {
    const warningMock = jest.spyOn(core, 'warning').mockImplementation()

    const params = helpers.parse_additional_parameters(`p1=v1
no_equals_here
p2=v2`)

    expect(params).toEqual({ p1: 'v1', p2: 'v2' })
    expect(warningMock).toHaveBeenCalledTimes(1)
    expect(warningMock).toHaveBeenCalledWith(
      expect.stringContaining('no_equals_here')
    )
  })
})
