import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MessageReportButton } from './message-report'
vi.mock('@/components/assistant-ui/tooltip-icon-button',()=>({TooltipIconButton:({tooltip,children,...props}:any)=><button aria-label={tooltip} {...props}>{children}</button>}))
vi.mock('@/components/ui/dialog',()=>({Dialog:({open,children}:any)=>open?<div>{children}</div>:null,DialogContent:({children}:any)=><div>{children}</div>,DialogHeader:({children}:any)=><header>{children}</header>,DialogTitle:({children}:any)=><h2>{children}</h2>,DialogDescription:({children}:any)=><p>{children}</p>,DialogFooter:({children}:any)=><footer>{children}</footer>}))
const submit=vi.fn(),status=vi.fn()
beforeEach(()=>{
  vi.clearAllMocks()
  status.mockResolvedValue({scope:"scope-from-native",organization:false,available:true})
  submit.mockResolvedValue({reportId:'ticket-from-server'})
  window.youtabDesktop={messageReports:{status,submit}} as any
})
describe('explicit message report submission',()=>{
  it('does not send on opening and excludes response text unless selected',async()=>{
    render(<MessageReportButton getMessageText={()=>'Private response text'} messageId="msg-1" />)
    fireEvent.click(screen.getByRole('button',{name:'Report'}))
    await waitFor(()=>expect(status).toHaveBeenCalled())
    expect(submit).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'Please investigate'}})
    fireEvent.click(screen.getByRole('button',{name:'Send report'}))
    await screen.findByText('ticket-from-server')
    expect(submit).toHaveBeenCalledWith({messageId:'msg-1',reason:'Please investigate'},'scope-from-native')
  })
  it('sends the user-reviewed excerpt only after opt-in',async()=>{
    render(<MessageReportButton getMessageText={()=>'Original excerpt'} messageId="msg-2" />)
    fireEvent.click(screen.getByRole('button',{name:'Report'}))
    await waitFor(()=>expect(status).toHaveBeenCalled())
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'Wrong result'}})
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByRole('textbox',{name:/Review the excerpt/}),{target:{value:'Edited excerpt'}})
    fireEvent.click(screen.getByRole('button',{name:'Send report'}))
    await screen.findByText('ticket-from-server')
    expect(submit).toHaveBeenCalledWith({messageId:'msg-2',reason:'Wrong result',excerpt:'Edited excerpt'},'scope-from-native')
  })
  it('blocks organization delivery visibly instead of using the personal endpoint',async()=>{
    status.mockResolvedValue({scope:"organization-scope",organization:true,available:false})
    render(<MessageReportButton getMessageText={()=>'Organization data'} messageId="msg-3" />)
    fireEvent.click(screen.getByRole('button',{name:'Report'}))
    await screen.findByText(/Organization enrollment/)
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'Report'}})
    expect((screen.getByRole('button',{name:'Send report'}) as HTMLButtonElement).disabled).toBe(true)
    expect(submit).not.toHaveBeenCalled()
  })
  it('keeps an unconfirmed report open and does not show success',async()=>{
    submit.mockRejectedValue(new Error('offline'))
    render(<MessageReportButton getMessageText={()=>'Text'} messageId="msg-4" />)
    fireEvent.click(screen.getByRole('button',{name:'Report'}))
    await waitFor(()=>expect(status).toHaveBeenCalled())
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'Problem'}})
    fireEvent.click(screen.getByRole('button',{name:'Send report'}))
    await screen.findByRole('alert')
    expect(screen.queryByText('ticket-from-server')).toBeNull()
  })
})
