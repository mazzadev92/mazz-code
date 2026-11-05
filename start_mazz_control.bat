@echo off
title MAZZ CONTROL :: Passerelle GPU et Supervision
echo ======================================================================
echo           MAZZ CONTROL :: DEMARRAGE DU TABLEAU DE BORD LOCAL
echo ======================================================================
echo Interface Web : http://127.0.0.1:7070
echo Endpoint API  : http://127.0.0.1:7070/v1
echo ======================================================================
python "%~dp0app.py"
pause
