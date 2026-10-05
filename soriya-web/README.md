# Soriya - Interface (accès par compte Google)

Projet Apps Script séparé (`Soriya - Interface`) qui affiche l'interface web de Soriya **sans clé dans l'adresse**.

- S'exécute avec le compte Google du visiteur (`executeAs: USER_ACCESSING`) et ne demande que la lecture des feuilles de calcul.
- Le visiteur ne voit les données que si les journaux Soriya, le tableau de bord et la liste des prospects sont partagés avec lui.
- `Index.html` est une copie de `../soriya/Index.html` : après toute modification de l'interface, recopier puis publier :

```
cp ../soriya/Index.html . && clasp push --force && clasp update-deployment AKfycbzs5Y9lPhUWmcVa229rCFnTs2HIg-eBnpL33TPRt8wwpXHsfMTXHMAT7rp5KiVrAl_Y
```
