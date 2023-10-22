import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejsLambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from '@aws-cdk/aws-apigatewayv2-alpha';
import * as integrations from '@aws-cdk/aws-apigatewayv2-integrations-alpha';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import assert from 'node:assert';
import { Construct } from 'constructs';

export interface TinyDeviceFlowStackStackProps extends cdk.StackProps {
  name: string;
  userPool: string;
  region: string;
  environment: string;
  domain: string;
  responseType?: string;
  identityProvider?: string;
  scopes: {
    phone: boolean;
    email: boolean;
    openid: boolean;
    profile: boolean;
    'aws.cognito.signin.user.admin': boolean;
  };
}

export class TinyDeviceFlowStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props: TinyDeviceFlowStackStackProps
  ) {
    super(scope, id, props);

    const api = new apigatewayv2.HttpApi(this, 'HttpApi', {
      apiName: `Device Authentication Flow API (${props.environment})`,
    });

    const userPool = new cognito.UserPool(this, props.userPool, {
      userPoolName: props.userPool,
      signInAliases: {
        username: true,
        email: true,
        preferredUsername: false,
        phone: false,
      },
      autoVerify: {
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
        },
        preferredUsername: {
          required: false,
        },
        phoneNumber: {
          required: false,
        },
      },
      mfa: cognito.Mfa.OPTIONAL,
      passwordPolicy: {
        minLength: 6,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    userPool.addDomain('UserPoolDomain', {
      cognitoDomain: {
        domainPrefix: props.domain,
      },
    });

    const appClient = new cognito.UserPoolClient(this, 'AppClient', {
      userPool,
      userPoolClientName: `${props.name}-user-pool-client`,
      authFlows: {
        adminUserPassword: true,
        userSrp: true,
        userPassword: true,
        custom: true,
      },
      oAuth: {
        callbackUrls: [
          `${api.url}oauth/process/index.html`,
          `${api.url}oauth/complete`,
        ],
        // logoutUrls,
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.COGNITO_ADMIN,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE,
        ],
      },
      preventUserExistenceErrors: true,
    });

    const userPoolIdentityPool = new cognito.CfnIdentityPool(this, 'IdPool', {
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: appClient.userPoolClientId,
          providerName: userPool.userPoolProviderName,
          serverSideTokenCheck: true,
        },
      ],
      identityPoolName: `${props.environment} users`,
    });

    const userUnauthenticatedRole = new iam.Role(
      this,
      'UserCognitoDefaultUnauthenticatedRole',
      {
        roleName: `${props.name}-unauth-role`,
        assumedBy: new iam.FederatedPrincipal(
          'cognito-identity.amazonaws.com',
          {
            StringEquals: {
              'cognito-identity.amazonaws.com:aud': userPoolIdentityPool.ref,
            },
            'ForAnyValue:StringLike': {
              'cognito-identity.amazonaws.com:amr': 'unauthenticated',
            },
          },
          'sts:AssumeRoleWithWebIdentity'
        ),
        inlinePolicies: {
          'allow-assume-role': new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                  'cognito-identity:*',
                  'cognito-idp:*',
                  'sts:GetFederationToken',
                  'sts:AssumeRoleWithWebIdentity',
                ],
                resources: ['*'],
              }),
            ],
          }),
        },
      }
    );

    const userAuthenticatedRole = new iam.Role(
      this,
      'UserCognitoDefaultAuthenticatedRole',
      {
        roleName: `${props.name}-auth-role`,
        assumedBy: new iam.FederatedPrincipal(
          'cognito-identity.amazonaws.com',
          {
            StringEquals: {
              'cognito-identity.amazonaws.com:aud': userPoolIdentityPool.ref,
            },
            'ForAnyValue:StringLike': {
              'cognito-identity.amazonaws.com:amr': 'authenticated',
            },
          },
          'sts:AssumeRoleWithWebIdentity'
        ),
        maxSessionDuration: cdk.Duration.hours(12),
        inlinePolicies: {
          'allow-assume-role': new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                  'cognito-identity:*',
                  'cognito-idp:*',
                  'sts:GetFederationToken',
                  'sts:AssumeRoleWithWebIdentity',
                ],
                resources: ['*'],
              }),
            ],
          }),
        },
      }
    );

    // eslint-disable-next-line no-new
    new cognito.CfnIdentityPoolRoleAttachment(
      this,
      'UsersIdPoolRoleAttachment',
      {
        identityPoolId: userPoolIdentityPool.ref,
        roles: {
          authenticated: userAuthenticatedRole.roleArn,
          unauthenticated: userUnauthenticatedRole.roleArn,
        },
      }
    );

    const deviceCodeTable = new dynamodb.Table(this, 'DeveiceCodeTable', {
      tableName: `${props.name}-device-code`,
      partitionKey: {
        name: 'device_code',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'user_code',
        type: dynamodb.AttributeType.STRING,
      },
      timeToLiveAttribute: 'expire',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const s3bucket = new s3.Bucket(this, 'S3Bucket', {
      bucketName: `${props.name}-static-site`,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
      accessControl: s3.BucketAccessControl.PRIVATE,
      publicReadAccess: false,
      cors: [
        {
          allowedHeaders: ['*'],
          allowedMethods: [s3.HttpMethods.POST],
          allowedOrigins: ['*'],
        },
      ],
    });

    // eslint-disable-next-line no-new
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [s3deploy.Source.asset(`${process.cwd()}/pages/out`)],
      destinationBucket: s3bucket,
      destinationKeyPrefix: 'web/static', // optional prefix in destination bucket
    });

    const resourceEndpointFnName = `${props.name}-resource-endpoint`;
    const resourceEndpointFnLogName = `/aws/lambda/${resourceEndpointFnName}`;
    // eslint-disable-next-line no-new
    new logs.LogGroup(this, 'ResourceEndpointLambdaFunctionLogGroup', {
      logGroupName: resourceEndpointFnLogName,
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const resourceEndpointFn = new nodejsLambda.NodejsFunction(
      this,
      'ResourceEndpointLambdaFunction',
      {
        runtime: lambda.Runtime.NODEJS_18_X,
        architecture: lambda.Architecture.ARM_64,
        entry: 'lambda/resource-endpoint/index.ts',
        functionName: resourceEndpointFnName,
        retryAttempts: 0,
        bundling: {
          minify: true,
          sourceMap: true,
          target: 'es2022',
          externalModules: ['node'],
          buildArgs: {
            '--bundle': '',
            '--platform': 'node',
            '--format': 'cjs',
          },
        },
        environment: {
          REGION: props.region,
          BUCKET_NAME: s3bucket.bucketName,
          PATH_PREFIX: 'web/static',
        },
        role: new iam.Role(this, 'ResourceEndpointLambdaExecutionRole', {
          assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
          inlinePolicies: {
            'logs-policy': new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  actions: [
                    'logs:CreateLogGroup',
                    'logs:CreateLogStream',
                    'logs:PutLogEvents',
                  ],
                  resources: [
                    `arn:aws:logs:${props.region}:${this.account}:log-group:${resourceEndpointFnLogName}`,
                    `arn:aws:logs:${props.region}:${this.account}:log-group:${resourceEndpointFnLogName}:*`,
                  ],
                }),
              ],
            }),
            's3-role-policy': new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  actions: [
                    's3:GetAccountPublicAccessBlock',
                    's3:GetBucketAcl',
                    's3:GetBucketLocation',
                    's3:GetBucketPolicyStatus',
                    's3:GetBucketPublicAccessBlock',
                    's3:ListAllMyBuckets',
                  ],
                  resources: ['*'],
                }),
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  actions: ['s3:ListBucket'],
                  resources: [`${s3bucket.bucketArn}`],
                }),
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  actions: ['s3:Get*'],
                  resources: [
                    `${s3bucket.bucketArn}`,
                    `${s3bucket.bucketArn}/*`,
                  ],
                }),
              ],
            }),
          },
        }),
      }
    );

    const deviceCodeEndpointFnName = `${props.name}-device-code-endpoint`;
    const deviceCodeEndpointFnLogName = `/aws/lambda/${deviceCodeEndpointFnName}`;
    // eslint-disable-next-line no-new
    new logs.LogGroup(this, 'DeviceCodeEndpointLambdaFunctionLogGroup', {
      logGroupName: deviceCodeEndpointFnLogName,
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const deviceCodeEndpointFn = new nodejsLambda.NodejsFunction(
      this,
      'DeviceCodeEndpointLambdaFunction',
      {
        runtime: lambda.Runtime.NODEJS_18_X,
        architecture: lambda.Architecture.ARM_64,
        entry: 'lambda/device-code-endpoint/index.ts',
        functionName: deviceCodeEndpointFnName,
        retryAttempts: 0,
        bundling: {
          minify: true,
          sourceMap: true,
          target: 'es2022',
          externalModules: ['node'],
          buildArgs: {
            '--bundle': '',
            '--platform': 'node',
            '--format': 'cjs',
          },
        },
        environment: {
          REGION: props.region,
          TABLE_NAME: deviceCodeTable.tableName,
          CLIENT_ID: appClient.userPoolClientId,
          EXPIRE_IN_SEC: '300',
          VERIFICATION_URI: `${api.url!}oauth/device/activate`,
        },
        role: new iam.Role(this, 'DeviceCodeEndpointExecutionRole', {
          assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
          inlinePolicies: {
            'logs-policy': new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  actions: [
                    'logs:CreateLogGroup',
                    'logs:CreateLogStream',
                    'logs:PutLogEvents',
                  ],
                  resources: [
                    `arn:aws:logs:${props.region}:${this.account}:log-group:${deviceCodeEndpointFnLogName}`,
                    `arn:aws:logs:${props.region}:${this.account}:log-group:${deviceCodeEndpointFnLogName}:*`,
                  ],
                }),
              ],
            }),
          },
        }),
      }
    );

    const tokenEndpointFnName = `${props.name}-token-endpoint`;
    const tokenEndpointFnLogName = `/aws/lambda/${tokenEndpointFnName}`;
    // eslint-disable-next-line no-new
    new logs.LogGroup(this, 'TokenEndpointLambdaFunctionLogGroup', {
      logGroupName: tokenEndpointFnLogName,
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const tokenEndpointFn = new nodejsLambda.NodejsFunction(
      this,
      'TokenEndpointLambdaFunction',
      {
        runtime: lambda.Runtime.NODEJS_18_X,
        architecture: lambda.Architecture.ARM_64,
        entry: 'lambda/token-endpoint/index.ts',
        functionName: tokenEndpointFnName,
        retryAttempts: 0,
        environment: {
          REGION: props.region,
          TABLE_NAME: deviceCodeTable.tableName,
          CLIENT_ID: appClient.userPoolClientId,
        },
        bundling: {
          minify: true,
          sourceMap: true,
          target: 'es2022',
          externalModules: ['node'],
          buildArgs: {
            '--bundle': '',
            '--platform': 'node',
            '--format': 'cjs',
          },
        },
        role: new iam.Role(this, 'TokenEndpointLambdaExecutionRole', {
          assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
          inlinePolicies: {
            'logs-policy': new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  actions: [
                    'logs:CreateLogGroup',
                    'logs:CreateLogStream',
                    'logs:PutLogEvents',
                  ],
                  resources: [
                    `arn:aws:logs:${props.region}:${this.account}:log-group:${tokenEndpointFnLogName}`,
                    `arn:aws:logs:${props.region}:${this.account}:log-group:${tokenEndpointFnLogName}:*`,
                  ],
                }),
              ],
            }),
          },
        }),
      }
    );

    const { responseType, identityProvider, scopes } = props;

    const availableScopes = Object.entries(scopes)
      // eslint-disable-next-line no-shadow
      .filter((scope) => scope[1])
      // eslint-disable-next-line no-shadow
      .map((scope) => scope[0]);
    assert(
      availableScopes.length > 0,
      'The scopes must have at least one true entry.'
    );

    const scopeParam = Object.entries(scopes)
      // eslint-disable-next-line no-shadow
      .filter((scope) => scope[1])
      // eslint-disable-next-line no-shadow
      .map((scope) => scope[0])
      .reduce((acc, cur) => `${acc}+${cur}`);

    const activateEndpointFnName = `${props.name}-activate-endpoint`;
    const activateEndpointFnLogName = `/aws/lambda/${activateEndpointFnName}`;
    // eslint-disable-next-line no-new
    new logs.LogGroup(this, 'ActivateEndpointLambdaFunctionLogGroup', {
      logGroupName: activateEndpointFnLogName,
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const activateEndpointFn = new nodejsLambda.NodejsFunction(
      this,
      'ActivateEndpointLambdaFunction',
      {
        runtime: lambda.Runtime.NODEJS_18_X,
        architecture: lambda.Architecture.ARM_64,
        entry: 'lambda/activate-endpoint/index.ts',
        functionName: activateEndpointFnName,
        retryAttempts: 0,
        bundling: {
          minify: true,
          sourceMap: true,
          target: 'es2022',
          externalModules: ['node'],
          buildArgs: {
            '--bundle': '',
            '--platform': 'node',
            '--format': 'cjs',
          },
        },
        environment: {
          REGION: props.region,
          BUCKET_NAME: s3bucket.bucketName,
          TABLE_NAME: deviceCodeTable.tableName,
          DOMAIN: props.domain,
          AUTHORIZE_ENDPOINT: `https://${props.domain}.auth.${props.region}.amazoncognito.com/oauth2/authorize`,
          CLIENT_ID: appClient.userPoolClientId,
          REDIRECT_URI:
            responseType === 'token'
              ? `${api.url}oauth/process/index.html`
              : `${api.url}oauth/complete`,
          PATH_PREFIX: 'web/static',
          RESPONSE_TYPE: responseType || 'code',
          IDENTITY_PROVIDER: identityProvider || 'COGNITO',
          SCOPE: scopeParam === '' ? 'openid' : scopeParam,
        },
        role: new iam.Role(this, 'ActivateEndpointLambdaExecutionRole', {
          assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
          inlinePolicies: {
            'logs-policy': new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  actions: [
                    'logs:CreateLogGroup',
                    'logs:CreateLogStream',
                    'logs:PutLogEvents',
                  ],
                  resources: [
                    `arn:aws:logs:${props.region}:${this.account}:log-group:${activateEndpointFnLogName}`,
                    `arn:aws:logs:${props.region}:${this.account}:log-group:${activateEndpointFnLogName}:*`,
                  ],
                }),
              ],
            }),
            's3-role-policy': new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  actions: [
                    's3:GetAccountPublicAccessBlock',
                    's3:GetBucketAcl',
                    's3:GetBucketLocation',
                    's3:GetBucketPolicyStatus',
                    's3:GetBucketPublicAccessBlock',
                    's3:ListAllMyBuckets',
                  ],
                  resources: ['*'],
                }),
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  actions: ['s3:ListBucket'],
                  resources: [`${s3bucket.bucketArn}`],
                }),
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  actions: ['s3:Get*'],
                  resources: [
                    `${s3bucket.bucketArn}`,
                    `${s3bucket.bucketArn}/*`,
                  ],
                }),
              ],
            }),
          },
        }),
      }
    );

    const activateCompleteEndpointFnName = `${props.name}-activate-complete-endpoint`;
    const activateCompleteEndpointFnLogName = `/aws/lambda/${activateCompleteEndpointFnName}`;
    // eslint-disable-next-line no-new
    new logs.LogGroup(this, 'ActivateCompleteEndpointLambdaFunctionLogGroup', {
      logGroupName: activateCompleteEndpointFnLogName,
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const activateCompleteEndpointFn = new nodejsLambda.NodejsFunction(
      this,
      'ActivateCompleteEndpointLambdaFunction',
      {
        runtime: lambda.Runtime.NODEJS_18_X,
        architecture: lambda.Architecture.ARM_64,
        entry: 'lambda/activate-complete-endpoint/index.ts',
        functionName: activateCompleteEndpointFnName,
        bundling: {
          minify: true,
          sourceMap: true,
          target: 'es2022',
          externalModules: ['node'],
          buildArgs: {
            '--bundle': '',
            '--platform': 'node',
            '--format': 'cjs',
          },
        },
        retryAttempts: 0,
        environment: {
          REGION: props.region,
          BUCKET_NAME: s3bucket.bucketName,
          TABLE_NAME: deviceCodeTable.tableName,
          DOMAIN: props.domain,
          CLIENT_ID: appClient.userPoolClientId,
          REDIRECT_URI: `${api.url}oauth/complete`,
          RETRY_URI: `${api.url}oauth/device/activate`,
          PATH_PREFIX: 'web/static',
          RESPONSE_TYPE: responseType || 'code',
        },
        role: new iam.Role(
          this,
          'ActivateCompleteEndpointLambdaExecutionRole',
          {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            inlinePolicies: {
              'logs-policy': new iam.PolicyDocument({
                statements: [
                  new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                      'logs:CreateLogGroup',
                      'logs:CreateLogStream',
                      'logs:PutLogEvents',
                    ],
                    resources: [
                      `arn:aws:logs:${props.region}:${this.account}:log-group:${activateCompleteEndpointFnLogName}`,
                      `arn:aws:logs:${props.region}:${this.account}:log-group:${activateCompleteEndpointFnLogName}:*`,
                    ],
                  }),
                ],
              }),
              's3-role-policy': new iam.PolicyDocument({
                statements: [
                  new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                      's3:GetAccountPublicAccessBlock',
                      's3:GetBucketAcl',
                      's3:GetBucketLocation',
                      's3:GetBucketPolicyStatus',
                      's3:GetBucketPublicAccessBlock',
                      's3:ListAllMyBuckets',
                    ],
                    resources: ['*'],
                  }),
                  new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['s3:ListBucket'],
                    resources: [`${s3bucket.bucketArn}`],
                  }),
                  new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ['s3:Get*'],
                    resources: [
                      `${s3bucket.bucketArn}`,
                      `${s3bucket.bucketArn}/*`,
                    ],
                  }),
                ],
              }),
            },
          }
        ),
      }
    );

    [
      deviceCodeEndpointFn,
      tokenEndpointFn,
      activateEndpointFn,
      activateCompleteEndpointFn,
    ].forEach((fn) => deviceCodeTable.grantReadWriteData(fn));

    api.addRoutes({
      path: '/{proxy+}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        'proxy-handler',
        resourceEndpointFn
      ),
    });

    api.addRoutes({
      path: '/oauth/device/code',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        'code-handler',
        deviceCodeEndpointFn
      ),
    });

    api.addRoutes({
      path: '/oauth/token',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        'token-handler',
        tokenEndpointFn
      ),
    });

    api.addRoutes({
      path: '/oauth/device/activate',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        'activate-handler',
        activateEndpointFn
      ),
    });
    api.addRoutes({
      path: '/oauth/device/activate/{proxy+}',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        'activate-proxy-handler',
        activateEndpointFn
      ),
    });

    api.addRoutes({
      path: '/oauth/complete',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        'complete-handler',
        activateCompleteEndpointFn
      ),
    });
    api.addRoutes({
      path: '/oauth/complete/{proxy+}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        'complete-proxy-handler',
        activateCompleteEndpointFn
      ),
    });
  }
}
