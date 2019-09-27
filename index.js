
const express=require('express')
const fs=require('fs');
const error=require('./lib/error')
const ftp=require('./lib/ftp');

var app=express();


app.get('/ftp/api/get_dir',function(req,res){
    ftp.getDir({user:"zhou",password:"zhou1998"},function(err,list){
        if(err){
            error.error(err);
            res.status(500);
        }else{
            res.json(list);
        }
    })
})

app.listen(9090,function(){
    console.log('listen to port 9090');
})