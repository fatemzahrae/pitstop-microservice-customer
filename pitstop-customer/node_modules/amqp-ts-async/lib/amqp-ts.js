"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const AmqpLib = require("amqplib/callback_api");
const path = require("path");
const os = require("os");
var ApplicationName = process.env.AMQPTS_APPLICATIONNAME ||
    (path.parse ? path.parse(process.argv[1]).name : path.basename(process.argv[1]));
const DIRECT_REPLY_TO_QUEUE = "amq.rabbitmq.reply-to";
class Connection {
    constructor(url = "amqp://localhost", socketOptions = {}, reconnectStrategy = { retries: 0, interval: 1500 }) {
        this.connectedBefore = false;
        this._rebuilding = false;
        this.url = url;
        this.socketOptions = socketOptions;
        this.reconnectStrategy = reconnectStrategy;
        this._exchanges = {};
        this._queues = {};
        this._bindings = {};
        this.rebuildConnection();
    }
    rebuildConnection() {
        if (this._rebuilding) {
            return this.initialized;
        }
        this._retry = -1;
        this._rebuilding = true;
        this.initialized = new Promise((resolve, reject) => {
            this.tryToConnect(this, 0, (err) => {
                if (err) {
                    this._rebuilding = false;
                    reject(err);
                }
                else {
                    this._rebuilding = false;
                    if (this.connectedBefore) {
                    }
                    else {
                        this.connectedBefore = true;
                    }
                    resolve(null);
                }
            });
        });
        this.initialized.catch((err) => {
        });
        return this.initialized;
    }
    tryToConnect(thisConnection, retry, callback) {
        AmqpLib.connect(thisConnection.url, thisConnection.socketOptions, (err, connection) => {
            if (err) {
                if (retry <= this._retry) {
                    return;
                }
                this._retry = retry;
                if (thisConnection.reconnectStrategy.retries === 0 || thisConnection.reconnectStrategy.retries > retry) {
                    setTimeout(thisConnection.tryToConnect, thisConnection.reconnectStrategy.interval, thisConnection, retry + 1, callback);
                }
                else {
                    callback(err);
                }
            }
            else {
                var restart = (err) => {
                    connection.removeListener("error", restart);
                    thisConnection._rebuildAll(err);
                };
                connection.on("error", restart);
                thisConnection._connection = connection;
                callback(null);
            }
        });
    }
    _rebuildAll(err) {
        this.rebuildConnection();
        for (var exchangeId in this._exchanges) {
            var exchange = this._exchanges[exchangeId];
            exchange._initialize();
        }
        for (var queueId in this._queues) {
            var queue = this._queues[queueId];
            var consumer = queue._consumer;
            queue._initialize();
            if (consumer) {
                queue._initializeConsumer();
            }
        }
        for (var bindingId in this._bindings) {
            var binding = this._bindings[bindingId];
            binding._initialize();
        }
        return new Promise((resolve, reject) => {
            this.completeConfiguration().then(() => {
                resolve(null);
            }, (rejectReason) => {
                reject(rejectReason);
            });
        });
    }
    close() {
        return new Promise((resolve, reject) => {
            this.initialized.then(() => {
                this._connection.close(err => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve(null);
                    }
                });
            });
        });
    }
    completeConfiguration() {
        var promises = [];
        for (var exchangeId in this._exchanges) {
            var exchange = this._exchanges[exchangeId];
            promises.push(exchange.initialized);
        }
        for (var queueId in this._queues) {
            var queue = this._queues[queueId];
            promises.push(queue.initialized);
            if (queue._consumerInitialized) {
                promises.push(queue._consumerInitialized);
            }
        }
        for (var bindingId in this._bindings) {
            var binding = this._bindings[bindingId];
            promises.push(binding.initialized);
        }
        return Promise.all(promises);
    }
    deleteConfiguration() {
        var promises = [];
        for (var bindingId in this._bindings) {
            var binding = this._bindings[bindingId];
            promises.push(binding.delete());
        }
        for (var queueId in this._queues) {
            var queue = this._queues[queueId];
            if (queue._consumerInitialized) {
                promises.push(queue.stopConsumer());
            }
            promises.push(queue.delete());
        }
        for (var exchangeId in this._exchanges) {
            var exchange = this._exchanges[exchangeId];
            promises.push(exchange.delete());
        }
        return Promise.all(promises);
    }
    declareExchange(name, type, options) {
        var exchange = this._exchanges[name];
        if (exchange === undefined) {
            exchange = new Exchange(this, name, type, options);
        }
        return exchange;
    }
    declareQueue(name, options) {
        var queue = this._queues[name];
        if (queue === undefined) {
            queue = new Queue(this, name, options);
        }
        return queue;
    }
    declareTopology(topology) {
        var promises = [];
        var i;
        var len;
        if (topology.exchanges !== undefined) {
            for (i = 0, len = topology.exchanges.length; i < len; i++) {
                var exchange = topology.exchanges[i];
                promises.push(this.declareExchange(exchange.name, exchange.type, exchange.options).initialized);
            }
        }
        if (topology.queues !== undefined) {
            for (i = 0, len = topology.queues.length; i < len; i++) {
                var queue = topology.queues[i];
                promises.push(this.declareQueue(queue.name, queue.options).initialized);
            }
        }
        if (topology.bindings !== undefined) {
            for (i = 0, len = topology.bindings.length; i < len; i++) {
                var binding = topology.bindings[i];
                var source = this.declareExchange(binding.source);
                var destination;
                if (binding.exchange !== undefined) {
                    destination = this.declareExchange(binding.exchange);
                }
                else {
                    destination = this.declareQueue(binding.queue);
                }
                promises.push(destination.bind(source, binding.pattern, binding.args));
            }
        }
        return Promise.all(promises);
    }
}
exports.Connection = Connection;
(function (Connection) {
    "use strict";
})(Connection = exports.Connection || (exports.Connection = {}));
class Message {
    constructor(content, options = {}) {
        this.properties = options;
        if (content !== undefined) {
            this.setContent(content);
        }
    }
    setContent(content) {
        if (typeof content === "string") {
            this.content = new Buffer(content);
        }
        else if (!(content instanceof Buffer)) {
            this.content = new Buffer(JSON.stringify(content));
            this.properties.contentType = "application/json";
        }
        else {
            this.content = content;
        }
    }
    getContent() {
        var content = this.content.toString();
        if (this.properties.contentType === "application/json") {
            content = JSON.parse(content);
        }
        return content;
    }
    async sendTo(destination, routingKey = "") {
        var sendMessage = async () => {
            try {
                destination._channel.publish(exchange, routingKey, this.content, this.properties);
            }
            catch (err) {
                var destinationName = destination._name;
                var connection = destination._connection;
                connection._rebuildAll(err).then(() => {
                    if (destination instanceof Queue) {
                        connection._queues[destinationName].publish(this.content, this.properties);
                    }
                    else {
                        connection._exchanges[destinationName].publish(this.content, routingKey, this.properties);
                    }
                });
            }
        };
        var exchange;
        if (destination instanceof Queue) {
            exchange = "";
            routingKey = destination._name;
        }
        else {
            exchange = destination._name;
        }
        await destination.initialized;
        await sendMessage();
    }
    ack(allUpTo) {
        if (this._channel !== undefined) {
            this._channel.ack(this._message, allUpTo);
        }
    }
    nack(allUpTo, requeue) {
        if (this._channel !== undefined) {
            this._channel.nack(this._message, allUpTo, requeue);
        }
    }
    reject(requeue = false) {
        if (this._channel !== undefined) {
            this._channel.reject(this._message, requeue);
        }
    }
}
exports.Message = Message;
class Exchange {
    get name() {
        return this._name;
    }
    get type() {
        return this._type;
    }
    constructor(connection, name, type, options = {}) {
        this._connection = connection;
        this._name = name;
        this._type = type;
        this._options = options;
        this._initialize();
    }
    _initialize() {
        this.initialized = new Promise((resolve, reject) => {
            this._connection.initialized.then(() => {
                this._connection._connection.createChannel((err, channel) => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        this._channel = channel;
                        let callback = (err, ok) => {
                            if (err) {
                                delete this._connection._exchanges[this._name];
                                reject(err);
                            }
                            else {
                                resolve(ok);
                            }
                        };
                        if (this._options.noCreate) {
                            this._channel.checkExchange(this._name, callback);
                        }
                        else {
                            this._channel.assertExchange(this._name, this._type, this._options, callback);
                        }
                    }
                });
            });
        });
        this._connection._exchanges[this._name] = this;
    }
    publish(content, routingKey = "", options = {}) {
        if (typeof content === "string") {
            content = new Buffer(content);
        }
        else if (!(content instanceof Buffer)) {
            content = new Buffer(JSON.stringify(content));
            options.contentType = options.contentType || "application/json";
        }
        this.initialized.then(() => {
            try {
                this._channel.publish(this._name, routingKey, content, options);
            }
            catch (err) {
                var exchangeName = this._name;
                var connection = this._connection;
                connection._rebuildAll(err).then(() => {
                    connection._exchanges[exchangeName].publish(content, routingKey, options);
                });
            }
        });
    }
    async send(message, routingKey = "") {
        return message.sendTo(this, routingKey);
    }
    async rpc(requestParameters, routingKey = "") {
        return new Promise(async (resolve, reject) => {
            var processRpc = async () => {
                var consumerTag;
                this._channel.consume(DIRECT_REPLY_TO_QUEUE, (resultMsg) => {
                    this._channel.cancel(consumerTag);
                    var result = new Message(resultMsg.content, resultMsg.fields);
                    result.fields = resultMsg.fields;
                    resolve(result);
                }, { noAck: true }, async (err, ok) => {
                    if (err) {
                        reject(new Error("amqp-ts: Queue.rpc error: " + err.message));
                    }
                    else {
                        consumerTag = ok.consumerTag;
                        var message = new Message(requestParameters, { replyTo: DIRECT_REPLY_TO_QUEUE });
                        await message.sendTo(this, routingKey);
                    }
                });
            };
            await this.initialized;
            await processRpc();
        });
    }
    delete() {
        if (this._deleting === undefined) {
            this._deleting = new Promise((resolve, reject) => {
                this.initialized.then(() => {
                    return Binding.removeBindingsContaining(this);
                }).then(() => {
                    this._channel.deleteExchange(this._name, {}, (err, ok) => {
                        if (err) {
                            reject(err);
                        }
                        else {
                            this._channel.close((err) => {
                                delete this.initialized;
                                delete this._connection._exchanges[this._name];
                                if (err) {
                                    reject(err);
                                }
                                else {
                                    delete this._channel;
                                    delete this._connection;
                                    resolve(null);
                                }
                            });
                        }
                    });
                }).catch((err) => {
                    reject(err);
                });
            });
        }
        return this._deleting;
    }
    close() {
        if (this._closing === undefined) {
            this._closing = new Promise((resolve, reject) => {
                this.initialized.then(() => {
                    return Binding.removeBindingsContaining(this);
                }).then(() => {
                    delete this.initialized;
                    delete this._connection._exchanges[this._name];
                    this._channel.close((err) => {
                        if (err) {
                            reject(err);
                        }
                        else {
                            delete this._channel;
                            delete this._connection;
                            resolve(null);
                        }
                    });
                }).catch((err) => {
                    reject(err);
                });
            });
        }
        return this._closing;
    }
    bind(source, pattern = "", args = {}) {
        var binding = new Binding(this, source, pattern, args);
        return binding.initialized;
    }
    unbind(source, pattern = "", args = {}) {
        return this._connection._bindings[Binding.id(this, source, pattern)].delete();
    }
    consumerQueueName() {
        return this._name + "." + ApplicationName + "." + os.hostname() + "." + process.pid;
    }
    startConsumer(onMessage, options) {
        var queueName = this.consumerQueueName();
        if (this._connection._queues[queueName]) {
            return new Promise((_, reject) => {
                reject(new Error("amqp-ts Exchange.startConsumer error: consumer already defined"));
            });
        }
        else {
            var promises = [];
            var queue = this._connection.declareQueue(queueName, { durable: false });
            promises.push(queue.initialized);
            var binding = queue.bind(this);
            promises.push(binding);
            var consumer = queue.startConsumer(onMessage, options);
            promises.push(consumer);
            return Promise.all(promises);
        }
    }
    activateConsumer(onMessage, options) {
        var queueName = this.consumerQueueName();
        if (this._connection._queues[queueName]) {
            return new Promise((_, reject) => {
                reject(new Error("amqp-ts Exchange.activateConsumer error: consumer already defined"));
            });
        }
        else {
            var promises = [];
            var queue = this._connection.declareQueue(queueName, { durable: false });
            promises.push(queue.initialized);
            var binding = queue.bind(this);
            promises.push(binding);
            var consumer = queue.activateConsumer(onMessage, options);
            promises.push(consumer);
            return Promise.all(promises);
        }
    }
    stopConsumer() {
        var queue = this._connection._queues[this.consumerQueueName()];
        if (queue) {
            return queue.delete();
        }
        else {
            return Promise.resolve();
        }
    }
}
exports.Exchange = Exchange;
(function (Exchange) {
    "use strict";
})(Exchange = exports.Exchange || (exports.Exchange = {}));
class Queue {
    get name() {
        return this._name;
    }
    constructor(connection, name, options = {}) {
        this._connection = connection;
        this._name = name;
        this._options = options;
        this._connection._queues[this._name] = this;
        this._initialize();
    }
    _initialize() {
        this.initialized = new Promise((resolve, reject) => {
            this._connection.initialized.then(() => {
                this._connection._connection.createChannel((err, channel) => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        this._channel = channel;
                        let callback = (err, ok) => {
                            if (err) {
                                delete this._connection._queues[this._name];
                                reject(err);
                            }
                            else {
                                if (this._options.prefetch) {
                                    this._channel.prefetch(this._options.prefetch);
                                }
                                resolve(ok);
                            }
                        };
                        if (this._options.noCreate) {
                            this._channel.checkQueue(this._name, callback);
                        }
                        else {
                            this._channel.assertQueue(this._name, this._options, callback);
                        }
                    }
                });
            });
        });
    }
    static _packMessageContent(content, options) {
        if (typeof content === "string") {
            content = new Buffer(content);
        }
        else if (!(content instanceof Buffer)) {
            content = new Buffer(JSON.stringify(content));
            options.contentType = "application/json";
        }
        return content;
    }
    static _unpackMessageContent(msg) {
        var content = msg.content.toString();
        if (msg.properties.contentType === "application/json") {
            content = JSON.parse(content);
        }
        return content;
    }
    async publish(content, options = {}) {
        var sendMessage = async () => {
            try {
                this._channel.sendToQueue(this._name, content, options);
            }
            catch (err) {
                var queueName = this._name;
                var connection = this._connection;
                await connection._rebuildAll(err);
                await connection._queues[queueName].publish(content, options);
            }
        };
        content = Queue._packMessageContent(content, options);
        await this.initialized;
        sendMessage();
    }
    send(message, routingKey = "") {
        message.sendTo(this, routingKey);
    }
    async rpc(requestParameters) {
        return new Promise(async (resolve, reject) => {
            var processRpc = async () => {
                var consumerTag;
                this._channel.consume(DIRECT_REPLY_TO_QUEUE, (resultMsg) => {
                    this._channel.cancel(consumerTag);
                    var result = new Message(resultMsg.content, resultMsg.fields);
                    result.fields = resultMsg.fields;
                    resolve(result);
                }, { noAck: true }, async (err, ok) => {
                    if (err) {
                        reject(new Error("amqp-ts: Queue.rpc error: " + err.message));
                    }
                    else {
                        consumerTag = ok.consumerTag;
                        var message = new Message(requestParameters, { replyTo: DIRECT_REPLY_TO_QUEUE });
                        await message.sendTo(this);
                    }
                });
            };
            await this.initialized;
            await processRpc();
        });
    }
    prefetch(count) {
        this.initialized.then(() => {
            this._channel.prefetch(count);
            this._options.prefetch = count;
        });
    }
    recover() {
        return new Promise((resolve, reject) => {
            this.initialized.then(() => {
                this._channel.recover((err, ok) => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        resolve(null);
                    }
                });
            });
        });
    }
    startConsumer(onMessage, options = {}) {
        if (this._consumerInitialized) {
            return new Promise((_, reject) => {
                reject(new Error("amqp-ts Queue.startConsumer error: consumer already defined"));
            });
        }
        this._isStartConsumer = true;
        this._rawConsumer = (options.rawMessage === true);
        delete options.rawMessage;
        this._consumerOptions = options;
        this._consumer = onMessage;
        this._initializeConsumer();
        return this._consumerInitialized;
    }
    activateConsumer(onMessage, options = {}) {
        if (this._consumerInitialized) {
            return new Promise((_, reject) => {
                reject(new Error("amqp-ts Queue.activateConsumer error: consumer already defined"));
            });
        }
        this._consumerOptions = options;
        this._consumer = onMessage;
        this._initializeConsumer();
        return this._consumerInitialized;
    }
    _initializeConsumer() {
        var processedMsgConsumer = (msg) => {
            try {
                if (!msg) {
                    return;
                }
                var payload = Queue._unpackMessageContent(msg);
                var result = this._consumer(payload);
                if (msg.properties.replyTo) {
                    var options = {};
                    if (result instanceof Promise) {
                        result.then((resultValue) => {
                            resultValue = Queue._packMessageContent(result, options);
                            this._channel.sendToQueue(msg.properties.replyTo, resultValue, options);
                        }).catch((err) => {
                        });
                    }
                    else {
                        result = Queue._packMessageContent(result, options);
                        this._channel.sendToQueue(msg.properties.replyTo, result, options);
                    }
                }
                if (this._consumerOptions.noAck !== true) {
                    this._channel.ack(msg);
                }
            }
            catch (err) {
            }
        };
        var rawMsgConsumer = (msg) => {
            try {
                this._consumer(msg, this._channel);
            }
            catch (err) {
            }
        };
        var activateConsumerWrapper = (msg) => {
            try {
                var message = new Message(msg.content, msg.properties);
                message.fields = msg.fields;
                message._message = msg;
                message._channel = this._channel;
                var result = this._consumer(message);
                if (msg.properties.replyTo) {
                    if (result instanceof Promise) {
                        result.then((resultValue) => {
                            if (!(resultValue instanceof Message)) {
                                resultValue = new Message(resultValue, {});
                            }
                            this._channel.sendToQueue(msg.properties.replyTo, resultValue.content, resultValue.properties);
                        }).catch((err) => {
                        });
                    }
                    else {
                        if (!(result instanceof Message)) {
                            result = new Message(result, {});
                        }
                        this._channel.sendToQueue(msg.properties.replyTo, result.content, result.properties);
                    }
                }
            }
            catch (err) {
            }
        };
        this._consumerInitialized = new Promise((resolve, reject) => {
            this.initialized.then(() => {
                var consumerFunction = activateConsumerWrapper;
                if (this._isStartConsumer) {
                    consumerFunction = this._rawConsumer ? rawMsgConsumer : processedMsgConsumer;
                }
                this._channel.consume(this._name, consumerFunction, this._consumerOptions, (err, ok) => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        this._consumerTag = ok.consumerTag;
                        resolve(ok);
                    }
                });
            });
        });
    }
    stopConsumer() {
        if (!this._consumerInitialized || this._consumerStopping) {
            return Promise.resolve();
        }
        this._consumerStopping = true;
        return new Promise((resolve, reject) => {
            this._consumerInitialized.then(() => {
                this._channel.cancel(this._consumerTag, (err, ok) => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        delete this._consumerInitialized;
                        delete this._consumer;
                        delete this._consumerOptions;
                        delete this._consumerStopping;
                        resolve(null);
                    }
                });
            });
        });
    }
    delete() {
        if (this._deleting === undefined) {
            this._deleting = new Promise((resolve, reject) => {
                this.initialized.then(() => {
                    return Binding.removeBindingsContaining(this);
                }).then(() => {
                    return this.stopConsumer();
                }).then(() => {
                    return this._channel.deleteQueue(this._name, {}, (err, ok) => {
                        if (err) {
                            reject(err);
                        }
                        else {
                            delete this.initialized;
                            delete this._connection._queues[this._name];
                            this._channel.close((err) => {
                                if (err) {
                                    reject(err);
                                }
                                else {
                                    delete this._channel;
                                    delete this._connection;
                                    resolve(ok);
                                }
                            });
                        }
                    });
                }).catch((err) => {
                    reject(err);
                });
            });
        }
        return this._deleting;
    }
    close() {
        if (this._closing === undefined) {
            this._closing = new Promise((resolve, reject) => {
                this.initialized.then(() => {
                    return Binding.removeBindingsContaining(this);
                }).then(() => {
                    return this.stopConsumer();
                }).then(() => {
                    delete this.initialized;
                    delete this._connection._queues[this._name];
                    this._channel.close((err) => {
                        if (err) {
                            reject(err);
                        }
                        else {
                            delete this._channel;
                            delete this._connection;
                            resolve(null);
                        }
                    });
                }).catch((err) => {
                    reject(err);
                });
            });
        }
        return this._closing;
    }
    bind(source, pattern = "", args = {}) {
        var binding = new Binding(this, source, pattern, args);
        return binding.initialized;
    }
    unbind(source, pattern = "", args = {}) {
        return this._connection._bindings[Binding.id(this, source, pattern)].delete();
    }
}
exports.Queue = Queue;
(function (Queue) {
    "use strict";
})(Queue = exports.Queue || (exports.Queue = {}));
class Binding {
    constructor(destination, source, pattern = "", args = {}) {
        this._source = source;
        this._destination = destination;
        this._pattern = pattern;
        this._args = args;
        this._destination._connection._bindings[Binding.id(this._destination, this._source, this._pattern)] = this;
        this._initialize();
    }
    _initialize() {
        this.initialized = new Promise((resolve, reject) => {
            if (this._destination instanceof Queue) {
                var queue = this._destination;
                queue.initialized.then(() => {
                    queue._channel.bindQueue(this._destination._name, this._source._name, this._pattern, this._args, (err, ok) => {
                        if (err) {
                            delete this._destination._connection._bindings[Binding.id(this._destination, this._source, this._pattern)];
                            reject(err);
                        }
                        else {
                            resolve(this);
                        }
                    });
                });
            }
            else {
                var exchange = this._destination;
                exchange.initialized.then(() => {
                    exchange._channel.bindExchange(this._destination._name, this._source._name, this._pattern, this._args, (err, ok) => {
                        if (err) {
                            delete this._destination._connection._bindings[Binding.id(this._destination, this._source, this._pattern)];
                            reject(err);
                        }
                        else {
                            resolve(this);
                        }
                    });
                });
            }
        });
    }
    delete() {
        return new Promise((resolve, reject) => {
            if (this._destination instanceof Queue) {
                var queue = this._destination;
                queue.initialized.then(() => {
                    queue._channel.unbindQueue(this._destination._name, this._source._name, this._pattern, this._args, (err, ok) => {
                        if (err) {
                            reject(err);
                        }
                        else {
                            delete this._destination._connection._bindings[Binding.id(this._destination, this._source, this._pattern)];
                            resolve(null);
                        }
                    });
                });
            }
            else {
                var exchange = this._destination;
                exchange.initialized.then(() => {
                    exchange._channel.unbindExchange(this._destination._name, this._source._name, this._pattern, this._args, (err, ok) => {
                        if (err) {
                            reject(err);
                        }
                        else {
                            delete this._destination._connection._bindings[Binding.id(this._destination, this._source, this._pattern)];
                            resolve(null);
                        }
                    });
                });
            }
            ;
        });
    }
    static id(destination, source, pattern) {
        pattern = pattern || "";
        return "[" + source._name + "]to" + (destination instanceof Queue ? "Queue" : "Exchange") + "[" + destination._name + "]" + pattern;
    }
    static removeBindingsContaining(connectionPoint) {
        var connection = connectionPoint._connection;
        var promises = [];
        for (var bindingId in connection._bindings) {
            var binding = connection._bindings[bindingId];
            if (binding._source === connectionPoint || binding._destination === connectionPoint) {
                promises.push(binding.delete());
            }
        }
        return Promise.all(promises);
    }
}
exports.Binding = Binding;
//# sourceMappingURL=amqp-ts.js.map