const express = require('express')
const session = require('express-session')
const Client = require('ftp');
const body_parser=require('body-parser')
const fs = require('fs');
const error = require('./lib/error')

const API_PATH='/ftp/api/'
var app = express();

app.use(session({
    secret: 'ftp_web',
    cookie: {
        maxAge: 60 * 1000 * 30
    },
    saveUninitialized: false,
    resave: false
}))

app.use('/ftp/img',express.static(__dirname+'/img'))

app.use(body_parser.json());
app.use(body_parser.urlencoded({extended:false}));

app.get('/ftp',function(req,res){
    res.redirect('/ftp/login.html');
})


app.get('/ftp/login.html',function(req,res){
    if(req.session.ftp_connection){
        if(req.session.ftp_connection.flag){
            res.redirect('/ftp/index.html')
            return;
        }
    }
    res.sendFile(__dirname+'/login.html');
})

app.get('/ftp/index.html',function(req,res){
    if(!req.session.ftp_connection){
        res.redirect('/ftp/login.html');
        return;
    }
    if(!req.session.ftp_connection.flag){
        res.redirect('/ftp/login.html');
        return;
    }
    res.sendFile(__dirname+'/index.html');
})

app.post(API_PATH+'login',function(req,res){
    if(req.session.ftp_connection){
        if(req.session.ftp_connection.flag){
            req.session.ftp_connection.client.end();
        }
    }
    var user=req.body;
    console.log(user);
    var ftp=createFtp();
    req.session.ftp_connection=ftp;
    req.session.ftp_connection.client.on('ready',function(){
        req.session.ftp_connection.flag=1;
        res.json(createRes("success"));
    })
    req.session.ftp_connection.client.on('error',function(err){
        req.session.ftp_connection.flag=0;
        res.json(createRes("Login failed",err));
    })
    req.session.ftp_connection.client.on('close',function(err){
        req.session.ftp_connection.flag=0;
    })
    req.session.ftp_connection.client.on('end',function(err){
        req.session.ftp_connection.flag=0;
    })
    req.session.ftp_connection.client.connect({user:user.user,password:user.password});
    res.json(createRes("success"));
})

app.use(API_PATH,function(req,res,next){
    if(req.session.ftp_connection){
        if(req.session.ftp_connection.flag){
            next();
        }
    }
    res.json(createRes('Need login'));
})



app.get(API_PATH+'get_dir',function(req,res){
    req.session.ftp_connection.client.list(function(err,list){
        if(err){
            res.json(createRes("Error",err));
        }else{
            res.json(createRes("success",list));
        }

    })
})

app.listen(9090, function () {
    console.log('listen to port 9090');
})

function createFtp()
{
    var ftp=new Object();
    ftp.client=new Client();
    ftp.flag=0;
    return ftp;
}

function createRes(message,result)
{
    var res=new Object();
    if(message){
        res.message=message;
    }
    if(result){
        res.result=result;
    }
    return res;
}