import {Server as WebSocketServer} from 'ws';
import {logger} from '@react-native-community/cli-tools';
import prettyFormat from 'pretty-format';
import {Server as HttpServer} from 'http';
import {Server as HttpsServer} from 'https';
import messageSocketModule from './messageSocketServer';

/**
 * The eventsSocket websocket listens at the 'events/` for websocket
 * connections, on which all Metro reports will be emitted.
 *
 * This is mostly useful for developer tools (clients) that wants to monitor Metro,
 * and the apps connected to Metro.
 *
 * The eventsSocket provides the following features:
 * - it reports any Metro event (that is reported through a reporter) to all clients
 * - it reports any console.log's (and friends) from the connected app to all clients
 *   (as client_log event)
 * - it allows connected clients to send commands through Metro to the connected app.
 *   This reuses the generic command mechanism.
 *   Two useful commands are 'reload' and 'devmenu'.
 */

type Server = HttpServer | HttpsServer;

type Command = {
  version: number;
  type: 'command';
  command: string;
  params?: any;
};

/**
 * This number is used to version the communication protocol between
 * Dev tooling like Flipper and Metro, so that in the future we can recognize
 * messages coming from old clients, so that it will be simpler to implement
 * backward compatibility.
 *
 * We start at 2 as the protocol is currently the same as used internally at FB,
 * which happens to be at version 2 as well.
 */
const PROTOCOL_VERSION = 2;

function parseMessage<T extends Object>(data: string): T | undefined {
  try {
    const message = JSON.parse(data);
    if (message.version === PROTOCOL_VERSION) {
      return message;
    }
    logger.error(
      'Received message had wrong protocol version: ' + message.version,
    );
  } catch {
    logger.error('Failed to parse the message as JSON:\n' + data);
  }
  return undefined;
}

/**
 * Two types of messages will arrive in this function,
 * 1) messages generated by Metro itself (through the reporter abstraction)
 *    those are yet to be serialized, and can contain any kind of data structure
 * 2) a specific event generated by Metro is `client_log`, which describes
 *    console.* calls in the app.
 *    The arguments send to the console are pretty printed so that they can be
 *    displayed in a nicer way in dev tools
 *
 * @param message
 */
function serializeMessage(message: any) {
  // We do want to send Metro report messages, but their contents is not guaranteed to be serializable.
  // For some known types we will pretty print otherwise not serializable parts first:
  let toSerialize = message;
  if (message && message.error && message.error instanceof Error) {
    toSerialize = {
      ...message,
      error: prettyFormat(message.error, {
        escapeString: true,
        highlight: true,
        maxDepth: 3,
        min: true,
      }),
    };
  } else if (message && message.type === 'client_log') {
    toSerialize = {
      ...message,
      data: message.data.map((item: any) =>
        typeof item === 'string'
          ? item
          : prettyFormat(item, {
              escapeString: true,
              highlight: true,
              maxDepth: 3,
              min: true,
              plugins: [prettyFormat.plugins.ReactElement],
            }),
      ),
    };
  }
  try {
    return JSON.stringify(toSerialize);
  } catch (e) {
    logger.error('Failed to serialize: ' + e);
    return null;
  }
}

type MessageSocket = ReturnType<typeof messageSocketModule.attachToServer>;

/**
 * Starts the eventsSocket at the given path
 *
 * @param server
 * @param path typically: 'events/'
 * @param messageSocket: webSocket to which all connected RN apps are listening
 */
function attachToServer(
  server: Server,
  path: string,
  messageSocket: MessageSocket,
) {
  const wss = new WebSocketServer({
    server: server,
    path: path,
    verifyClient({origin}: {origin: string}) {
      // This exposes the full JS logs and enables issuing commands like reload
      // so let's make sure only locally running stuff can connect to it
      // origin is only checked if it is set, e.g. when the request is made from a (CORS) browser
      // any 'back-end' connection isn't CORS at all, and has full control over the origin header,
      // so there is no point in checking it security wise
      return (
        !origin ||
        origin.startsWith('http://localhost:') ||
        origin.startsWith('file:')
      );
    },
  });

  const clients = new Map();
  let nextClientId = 0;

  /**
   * broadCastEvent is called by reportEvent (below), which is called by the
   * default reporter of this server, to make sure that all Metro events are
   * broadcasted to all connected clients
   * (that is, all devtools such as Flipper, _not_: connected apps)
   *
   * @param message
   */
  function broadCastEvent(message: any) {
    if (!clients.size) {
      return;
    }
    const serialized = serializeMessage(message);
    if (!serialized) {
      return;
    }
    for (const ws of clients.values()) {
      try {
        ws.send(serialized);
      } catch (e) {
        logger.error(
          `Failed to send broadcast to client due to:\n ${e.toString()}`,
        );
      }
    }
  }

  wss.on('connection', function (clientWs) {
    const clientId = `client#${nextClientId++}`;

    clients.set(clientId, clientWs);

    clientWs.onclose = clientWs.onerror = () => {
      clients.delete(clientId);
    };

    clientWs.onmessage = (event) => {
      const message: Command | undefined = parseMessage(event.data.toString());
      if (message == null) {
        return;
      }
      if (message.type === 'command') {
        try {
          /**
           * messageSocket.broadcast (not to be confused with our own broadcast above)
           * forwards a command to all connected React Native applications.
           */
          messageSocket.broadcast(message.command, message.params);
        } catch (e) {
          logger.error('Failed to forward message to clients: ', e);
        }
      } else {
        logger.error('Unknown message type: ', message.type);
      }
    };
  });

  return {
    reportEvent: (event: any) => {
      broadCastEvent(event);
    },
  };
}

export default {
  attachToServer,
};
