import { themed } from '@deity/falcon-ui';

export type AddressListLayoutProps = Parameters<typeof AddressListLayout>[0];
export const AddressListLayout = themed({
  tag: 'ul',
  defaultTheme: {
    addressListLayout: {
      display: 'grid',
      gridTemplateColumns: {
        xs: '1fr',
        md: 'repeat(2, 1fr)'
      },
      gridGap: 'md',
      m: 'none',
      p: 'none',
      css: {
        listStyle: 'none'
      }
    }
  }
});
