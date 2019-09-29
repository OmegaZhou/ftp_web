const Client = require('ftp')
const fs = require('fs')
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
            client_map.get(ftp.id).client.end();
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
            console.log(list)
            for (var i = 0; i < list.length; ++i) {
                list[i].name = Buffer.from(list[i].name.toString(), 'binary').toString('utf-8');
            }
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
    ftp.client.cwd(path.toString(), function (err, data) {
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
    ftp.client.get(path, true, function (err, data) {
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

exports.mkdir = function (req, res) {
    var index = req.session.id;
    var ftp = client_map.get(index);
    var path = req.body.path;
    console.log(path);
    ftp.client.mkdir(path, function (err) {
        if (err) {
            console.log(err)
            res.json(createRes("Error", err));
        } else {
            //console.log(data)
            res.json(createRes("success"));
        }
    })
}

exports.upload = function (req, res) {
    var index = req.session.id;
    var ftp = client_map.get(index);
    var path = req.body.path;
    var name = req.body.name;
    var origin = req.file;
    ftp.client.put(path + name, origin.path, function (err) {

        if (err) {
            res.json(createRes("Error", err));
        } else {
            fs.unlink(origin.path, err => {

            })
            //console.log(data)
            res.json(createRes("success"));
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
