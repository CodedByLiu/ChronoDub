import { Plus, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table'

interface DictionarySectionProps {
  dictionary: Array<{ en: string; zh: string }>
  newEn: string
  newZh: string
  onChangeNewEn: (value: string) => void
  onChangeNewZh: (value: string) => void
  onAdd: () => void
  onRemove: (index: number) => void
}

export function DictionarySection({
  dictionary,
  newEn,
  newZh,
  onChangeNewEn,
  onChangeNewZh,
  onAdd,
  onRemove,
}: DictionarySectionProps) {
  return (
    <div className="space-y-2">
      <Label>术语词典</Label>
      <p className="text-xs text-muted-foreground">翻译时保留专业术语原意。</p>
      {dictionary.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[120px]">英文</TableHead>
              <TableHead className="w-[120px]">中文</TableHead>
              <TableHead className="w-[40px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {dictionary.map((item, index) => (
              <TableRow key={index}>
                <TableCell className="py-1">{item.en}</TableCell>
                <TableCell className="py-1">{item.zh}</TableCell>
                <TableCell className="py-1">
                  <Button variant="ghost" size="icon-xs" onClick={() => onRemove(index)}>
                    <Trash2 className="size-3" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <div className="flex items-center gap-2">
        <Input
          placeholder="英文"
          value={newEn}
          onChange={(event) => onChangeNewEn(event.target.value)}
          className="min-w-0 flex-1"
          onKeyDown={(event) => event.key === 'Enter' && onAdd()}
        />
        <Input
          placeholder="中文"
          value={newZh}
          onChange={(event) => onChangeNewZh(event.target.value)}
          className="min-w-0 flex-1"
          onKeyDown={(event) => event.key === 'Enter' && onAdd()}
        />
        <Button variant="outline" size="icon" className="shrink-0" onClick={onAdd} aria-label="添加术语">
          <Plus className="size-4" />
        </Button>
      </div>
    </div>
  )
}
