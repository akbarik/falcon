import { ApolloError } from 'apollo-client';
import { codes } from '@deity/falcon-errors';

export type ErrorModel = {
  message: string;
  code?: string;
  /** path to property (on operation input or operation output) on which error occurs */
  path?: any;
};

export const apolloErrorToErrorModelList = (error: ApolloError): ErrorModel[] => {
  const { networkError, graphQLErrors } = error;

  if (networkError) {
    return [
      {
        message: networkError.message
      }
    ];
  }

  if (graphQLErrors) {
    return graphQLErrors.reduce<ErrorModel[]>((result, { message, extensions = {} }) => {
      if (extensions.code === codes.BAD_USER_INPUT && extensions.exception) {
        const userInputErrors = Object.keys(extensions.exception).map(x => ({
          message: extensions.exception[x],
          code: extensions.code,
          path: x
        }));

        return [...result, ...userInputErrors];
      }

      return [...result, { message, code: extensions.code }];
    }, []);
  }

  return [
    {
      message: error.message
    }
  ];
};
