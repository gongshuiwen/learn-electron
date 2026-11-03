import type { ComponentProps } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-teal-600 disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4',
  {
    variants: {
      variant: {
        default: 'bg-teal-700 text-white hover:bg-teal-800',
        outline:
          'border border-stone-300 hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

function Button({
  className,
  variant,
  type = 'button',
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return (
    <button
      data-slot="button"
      type={type}
      className={cn(buttonVariants({ variant, className }))}
      {...props}
    />
  )
}

export { Button }
