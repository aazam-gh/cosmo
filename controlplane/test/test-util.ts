import { createPromiseClient, PromiseClient } from '@connectrpc/connect';
import { fastifyConnectPlugin } from '@connectrpc/connect-fastify';
import { createConnectTransport } from '@connectrpc/connect-node';
import { EnumStatusCode } from '@wundergraph/cosmo-connect/dist/common/common_pb';
import { NodeService } from '@wundergraph/cosmo-connect/dist/node/v1/node_connect';
import { PlatformService } from '@wundergraph/cosmo-connect/dist/platform/v1/platform_connect';
import Fastify from 'fastify';
import { pino } from 'pino';
import { expect } from 'vitest';
import { BlobNotFoundError, BlobObject, BlobStorage } from '../src/core/blobstorage/index.js';
import { ClickHouseClient } from '../src/core/clickhouse/index.js';
import database from '../src/core/plugins/database.js';
import fastifyRedis from '../src/core/plugins/redis.js';
import routes from '../src/core/routes.js';
import { Authorization } from '../src/core/services/Authorization.js';
import Keycloak from '../src/core/services/Keycloak.js';
import Mailer from '../src/core/services/Mailer.js';
import { createTestAuthenticator, seedTest } from '../src/core/test-util.js';
import { MockPlatformWebhookService } from '../src/core/webhooks/PlatformWebhookService.js';
import { AIGraphReadmeQueue } from '../src/core/workers/AIGraphReadmeWorker.js';
import { Label } from '../src/types/index.js';

export const SetupTest = async function ({ dbname, chClient }: { dbname: string; chClient?: ClickHouseClient }) {
  const log = pino();
  const databaseConnectionUrl = `postgresql://postgres:changeme@localhost:5432/${dbname}`;
  const server = Fastify({
    logger: log,
  });

  await server.register(database, {
    databaseConnectionUrl,
    debugSQL: false,
    runMigration: true,
  });

  const { authenticator, userTestData } = createTestAuthenticator();

  const realm = 'test';
  const apiUrl = 'http://localhost:8080';
  const clientId = 'studio';
  const adminUser = 'admin';
  const adminPassword = 'changeme';
  const webBaseUrl = 'http://localhost:3000';

  const keycloakClient = new Keycloak({
    apiUrl,
    realm,
    clientId,
    adminUser,
    adminPassword,
  });

  const platformWebhooks = new MockPlatformWebhookService();
  const mailerClient = new Mailer({ username: '', password: '' });

  await server.register(fastifyRedis, {
    host: 'localhost',
    port: 6379,
    password: 'test',
  });

  const readmeQueue = new AIGraphReadmeQueue(log, server.redisForQueue);

  const blobStorage = new InMemoryBlobStorage();
  await server.register(fastifyConnectPlugin, {
    routes: routes({
      chClient,
      db: server.db,
      logger: pino(),
      authenticator,
      jwtSecret: 'secret',
      keycloakRealm: realm,
      keycloakClient,
      platformWebhooks,
      webBaseUrl,
      slack: {
        clientID: '',
        clientSecret: '',
      },
      cdnBaseUrl: 'http://localhost:11000',
      admissionWebhookJWTSecret: 'secret',
      keycloakApiUrl: apiUrl,
      blobStorage,
      mailerClient,
      authorizer: new Authorization(log),
      readmeQueue,
    }),
  });

  const addr = await server.listen({
    port: 0,
  });

  await seedTest(databaseConnectionUrl, userTestData);

  const transport = createConnectTransport({
    httpVersion: '1.1',
    baseUrl: addr,
  });

  const platformClient = createPromiseClient(PlatformService, transport);
  const nodeClient = createPromiseClient(NodeService, transport);

  return { client: platformClient, nodeClient, server, userTestData, blobStorage };
};

export const createSubgraph = async (
  client: PromiseClient<typeof PlatformService>,
  name: string,
  namespace: string,
  schemaSDL: string,
  labels: Label[],
  routingUrl: string,
) => {
  const createRes = await client.createFederatedSubgraph({
    name,
    namespace,
    labels,
    routingUrl,
  });
  expect(createRes.response?.code).toBe(EnumStatusCode.OK);
  const publishResp = await client.publishFederatedSubgraph({
    name,
    namespace,
    schema: schemaSDL,
  });
  expect(publishResp.response?.code).toBe(EnumStatusCode.OK);

  return publishResp;
};

export const createFederatedGraph = async (
  client: PromiseClient<typeof PlatformService>,
  name: string,
  namespace: string,
  labelMatchers: string[],
  routingUrl: string,
) => {
  const createFedGraphRes = await client.createFederatedGraph({
    name,
    namespace,
    routingUrl,
    labelMatchers,
  });
  expect(createFedGraphRes.response?.code).toBe(EnumStatusCode.OK);
  return createFedGraphRes;
};

export class InMemoryBlobStorage implements BlobStorage {
  private objects: Map<string, Buffer> = new Map();

  keys() {
    return [...this.objects.keys()];
  }

  putObject<Metadata extends Record<string, string>>({
    key,
    body,
  }: {
    key: string;
    body: Buffer;
    abortSignal?: AbortSignal;
    contentType: string;
    metadata?: Metadata;
  }): Promise<void> {
    this.objects.set(key, body);
    return Promise.resolve();
  }

  getObject(data: { key: string; abortSignal?: AbortSignal }): Promise<BlobObject> {
    const obj = this.objects.get(data.key);
    if (!obj) {
      return Promise.reject(new BlobNotFoundError(`Object with key ${data.key} not found`));
    }
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(obj);
        controller.close();
      },
    });
    return Promise.resolve({
      stream,
    });
  }

  deleteObject(data: { key: string; abortSignal?: AbortSignal }): Promise<void> {
    this.objects.delete(data.key);
    return Promise.resolve();
  }

  removeDirectory(data: { key: string; abortSignal?: AbortSignal }): Promise<number> {
    let count = 0;
    for (const objectKey of this.objects.keys()) {
      if (objectKey.startsWith(data.key)) {
        this.objects.delete(objectKey);
        count++;
      }
    }
    return Promise.resolve(count);
  }
}
