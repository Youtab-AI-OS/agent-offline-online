/** Keep a complete inline block on stdin; no script file or policy override. */
export const powershellInlineInput = (script: string) => '& {\n' + script + '\n}\n\n'
