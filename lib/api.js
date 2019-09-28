const Client = require('ftp')
var client_map = new Map();
exports.client_map = client_map;
exports.login = function (req, res) {
    if (req.session.ftp_connection) {
        if (req.session.ftp_connection.flag) {
            req.session.ftp_connection.client.end();
        }
    }
    var user = req.body;
    //console.log(user);
    req.session.ftp_connection = true;
    var ftp = createFtp(req.session.id);
    client_map.set(ftp.id, ftp);
    ftp.client.on('ready', function () {
        res.json(createRes("success"));
    })
    ftp.client.on('error', function (err) {
        if (client_map.has(ftp.id)) {
            client_map.getDir(ftp.id).end();
            client_map.delete(ftp.id);
        }
        console.log(err);
        if (err.code == 530) {
            res.json(createRes("Login failed", err));
        }
    })
    ftp.client.on('close', function (err) {
        if (client_map.has(ftp.id)) {
            client_map.delete(ftp.id);
        }
    })
    ftp.client.on('end', function (err) {
        if (client_map.has(ftp.id)) {
            client_map.delete(ftp.id);
        }
    })
    ftp.client.connect({ user: user.user, password: user.password });
}

exports.getDir = function (req, res) {
    var index = req.session.id;
    var ftp = client_map.get(index);
    ftp.client.list(function (err, list) {
        if (err) {
            res.json(createRes("Error", err));
        } else {
            list.map(item => {
                item.name = Buffer.from(item.name, 'binary').toString('utf8')
            })
            console.log(list)
            res.json(createRes("success", list));
        }
    })
}

exports.pwd = function (req, res) {
    var index = req.session.id;
    var ftp = client_map.get(index);
    ftp.client.pwd(function (err, data) {
        if (err) {
            res.json(createRes("Error", err));
        } else {
            res.json(createRes("success", Buffer.from(data, 'binary').toString('utf8')));
        }
    })
}

exports.cwd = function (req, res) {
    var index = req.session.id;
    var ftp = client_map.get(index);
    var path = req.body.path;
    ftp.client.cwd(path, function (err, data) {
        if (err) {
            res.json(createRes("Error", err));
        } else {
            //console.log(data)
            res.json(createRes("success", data));
        }
    })
}

exports.download = function (req, res) {
    var index = req.session.id;
    var ftp = client_map.get(index);
    var path = decodeURIComponent(req.params.path)
    console.log(path)
    ftp.client.get(path, function (err, data) {
        if (err) {
            res.status(404);
        } else {
            console.log('a')
            //console.log(data)
            res.writeHead(200, {
                'Content-Type': 'application/force-download'
            });
            data.pipe(res);
        }
    })
}

function createFtp(index) {
    var ftp = new Object();
    ftp.client = new Client();
    ftp.id = index;
    return ftp;
}

function createRes(message, result) {
    var res = new Object();
    if (message) {
        res.message = message;
    }
    if (result) {
        res.result = result;
    }
    return res;
}

exports.createRes = createRes;
