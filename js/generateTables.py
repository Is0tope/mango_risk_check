from markdownTable import markdownTable
import json

with open('idl.json') as f:
    idl = json.load(f)
    for ins in idl['instructions']:
        print('### ' + ins['name'])
        print('#### Accounts')
        print(markdownTable(ins['accounts']).setParams(row_sep = 'markdown', quote = False).getMarkdown())
        if(len(ins['args']) > 0):
            print('#### Arguments')
            print(markdownTable(ins['args']).setParams(row_sep = 'markdown', quote = False).getMarkdown())
        print()