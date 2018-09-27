import React from 'react';
import { Box, Details, Summary, DetailsContent } from '@deity/falcon-ui';

type MetaItem = {
  name: string;
  content: string;
};
export const ProductMeta: React.SFC<{
  meta: MetaItem[];
  onChange?: Function;
  activeItem?: MetaItem;
}> = ({ meta, onChange, activeItem }) => (
  <React.Fragment>
    <Box>
      {meta.map(item => (
        <Details key={item.name} open={activeItem && activeItem === item}>
          <Summary variant="secondary" onClick={() => onChange && onChange(item)}>
            {item.name}
          </Summary>
          <DetailsContent>{item.content}</DetailsContent>
        </Details>
      ))}
    </Box>
  </React.Fragment>
);
