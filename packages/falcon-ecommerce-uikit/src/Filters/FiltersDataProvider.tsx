import React from 'react';
import { Box, themed } from '@deity/falcon-ui';

export const FiltersLayout = themed({
  tag: Box,
  defaultTheme: {
    filtersPanelLayout: {
      display: 'grid',
      gridGap: 'sm',
      css: {
        width: '100%',
        alignContent: 'start'
      }
    }
  }
});
